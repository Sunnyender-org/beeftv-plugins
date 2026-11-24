// 云端生图任务状态表、幂等锁、参考图读取与重启残留任务清理。

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonIfExists, writePrivateJson } from "./colab-auth.mjs";
import { defaultFetch, isLoopbackHost } from "./net-transport.mjs";

const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_TASKS = 100;

const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function parseInlineDataUrl(dataUrl, fallbackMime = "image/png") {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ""));
  if (!match) return null;
  const body = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return { body, mimeType: match[1] || fallbackMime };
}

async function readSingleReference(reference, index, { fetchImpl = defaultFetch, signal } = {}) {
  const inline = parseInlineDataUrl(reference?.dataUrl, reference?.mimeType);
  if (inline) return inline;
  const label = `第 ${index + 1} 张参考图（@图片${index + 1}）`;
  const url = String(reference?.url ?? "").trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${label}缺少可读取的图片地址`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${label}缺少可读取的图片地址`);
  }
  const isLocalAsset = isLoopbackHost(parsedUrl.hostname);
  const res = await fetchImpl(
    url,
    isLocalAsset ? { signal, redirect: "error" } : { signal, requirePublicTarget: true },
  );
  if (!res.ok) {
    throw new Error(`读取${label}失败（HTTP ${res.status}）`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const mimeType = String(res.headers.get("content-type") || reference?.mimeType || "image/png").split(";")[0].trim();
  return { body, mimeType };
}

export async function readReferenceImages(references, { fetchImpl = defaultFetch, signal } = {}) {
  return Promise.all(
    references.map(async (ref, idx) => {
      const { body, mimeType } = await readSingleReference(ref, idx, { fetchImpl, signal });
      const ext = IMAGE_EXTENSIONS[mimeType] || "png";
      return { index: idx, body, mimeType, ext };
    }),
  );
}

export function sanitizeRetainedRequest(request) {
  const rawImages = Array.isArray(request?.images) ? request.images : [];
  return {
    model: String(request?.model ?? ""),
    prompt: String(request?.prompt ?? ""),
    negativePrompt: String(request?.negativePrompt ?? ""),
    aspectRatio: request?.aspectRatio,
    size: request?.size,
    quality: request?.quality,
    seed: request?.seed,
    images: rawImages.map((item) => ({ role: item?.role || "reference" })),
  };
}

export function normalizeIdempotencyKey(raw) {
  return String(raw ?? "").trim().replace(/[^\w-]/g, "").slice(0, 48);
}

export function formatTaskSubmission(task) {
  if (task.status === "succeeded") {
    return { taskId: task.taskId, status: "succeeded", result: task.result };
  }
  if (task.status === "failed") {
    return { taskId: task.taskId, status: "failed", message: task.message };
  }
  return { taskId: task.taskId, status: task.status };
}

export class ColabTaskStore {
  constructor({ tasksDir }) {
    this.tasksDir = tasksDir;
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
    this.tasks = new Map();
    this.idempotencyMap = new Map();
    this.idempotencyInFlight = new Map();
  }

  reconcileStartupTasks() {
    const cutoff = Date.now() - TASK_RETENTION_MS;
    try {
      for (const name of readdirSync(this.tasksDir)) {
        if (!name.endsWith(".json")) continue;
        const full = join(this.tasksDir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full, { force: true });
            continue;
          }
          const disk = readJsonIfExists(full);
          if (disk && (disk.status === "pending" || disk.status === "processing")) {
            writePrivateJson(full, {
              ...disk,
              status: "failed",
              message: "插件后台进程已重启，请重新发起生成",
              stageDetail: "插件后台进程已重启，请重新发起生成",
            });
          }
        } catch {
          // ignore file race
        }
      }
    } catch {
      // ignore unreadable dir
    }
  }

  runIdempotent(rawIdem, createFn) {
    const idemKey = normalizeIdempotencyKey(rawIdem);
    if (idemKey) {
      if (this.idempotencyMap.has(idemKey)) {
        const existing = this.tasks.get(this.idempotencyMap.get(idemKey));
        if (existing) return Promise.resolve(formatTaskSubmission(existing));
      }
      if (this.idempotencyInFlight.has(idemKey)) {
        return this.idempotencyInFlight.get(idemKey);
      }
    }

    const promise = Promise.resolve().then(() => createFn(idemKey));
    if (idemKey) {
      this.idempotencyInFlight.set(idemKey, promise);
      const cleanup = () => {
        this.idempotencyInFlight.delete(idemKey);
      };
      promise.then(cleanup, cleanup);
    }
    return promise;
  }

  createTask({ idemKey, request, config, modelSpec, inputImages }) {
    const taskId = `colab_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const record = {
      taskId,
      idemKey,
      request: sanitizeRetainedRequest(request),
      config,
      modelSpec,
      inputImages,
      status: "pending",
      stageDetail: "已加入云端生图队列，准备唤醒显卡",
      lastLoggedDetail: "",
      message: "",
      result: null,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, record);
    if (idemKey) {
      this.idempotencyMap.set(idemKey, taskId);
    }
    this.#pruneRetainedTasks();
    this.persistSummary(record);
    return record;
  }

  getInMemory(taskId) {
    return this.tasks.get(taskId) || null;
  }

  resolveForQuery(taskId) {
    const inMem = this.tasks.get(taskId);
    if (inMem) return inMem;
    const safeName = `${String(taskId ?? "").replace(/[^\w-]/g, "")}.json`;
    return readJsonIfExists(join(this.tasksDir, safeName));
  }

  findActiveTask() {
    for (const task of this.tasks.values()) {
      if (task.status === "processing" || task.status === "pending") {
        return task;
      }
    }
    return null;
  }

  persistSummary(task) {
    const safeName = `${String(task.taskId).replace(/[^\w-]/g, "")}.json`;
    writePrivateJson(join(this.tasksDir, safeName), {
      taskId: task.taskId,
      status: task.status,
      stageDetail: task.stageDetail,
      message: task.message,
      result: task.result,
      createdAt: task.createdAt,
    });
  }

  #pruneRetainedTasks() {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    for (const [id, rec] of this.tasks.entries()) {
      if (this.tasks.size <= MAX_RETAINED_TASKS) break;
      if (rec.status === "succeeded" || rec.status === "failed") {
        this.tasks.delete(id);
        if (rec.idemKey && this.idempotencyMap.get(rec.idemKey) === id) {
          this.idempotencyMap.delete(rec.idemKey);
        }
      }
    }
  }
}
