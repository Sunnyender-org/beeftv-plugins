// Google Colab 官方控制面与运行时代理客户端（零 Python 依赖，纯 Node / Bun 原生实现）。

import { randomUUID } from "node:crypto";
import { DEFAULT_COLAB_ORIGIN } from "./constants.mjs";
import { defaultFetch } from "./net-transport.mjs";
import { DefaultWebSocket } from "./ws-tunnel.mjs";

const XSSI_PREFIX = ")]}'\n";
const CLIENT_AGENT_HEADER = "colab-cli";
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONTROL_TIMEOUT_MS = 30 * 1000;
const DEFAULT_PROXY_META_TIMEOUT_MS = 30 * 1000;
const DEFAULT_PROXY_IO_TIMEOUT_MS = 90 * 1000;

export function stripXssiPrefix(text) {
  const raw = String(text ?? "");
  return raw.startsWith(XSSI_PREFIX) ? raw.slice(XSSI_PREFIX.length) : raw;
}

export function uuidToWebSafeBase64(uuidStr) {
  const clean = String(uuidStr).trim();
  const transformed = clean.replace(/-/g, "_");
  const padLen = Math.max(0, 44 - clean.length);
  return `${transformed}${".".repeat(padLen)}`;
}

export function normalizeColabOrigin(baseUrl, { allowLoopbackOrigin = false } = {}) {
  const raw = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_COLAB_ORIGIN;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Google Colab 服务地址格式不正确，请保持默认 ${DEFAULT_COLAB_ORIGIN}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isOfficialColab =
    parsed.protocol === "https:" &&
    (parsed.port === "" || parsed.port === "443") &&
    (host === "colab.research.google.com" || host.endsWith(".colab.research.google.com"));
  if (isOfficialColab) {
    return `${parsed.protocol}//${parsed.host}`;
  }
  const isLocalLoopback =
    allowLoopbackOrigin &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]");
  if (isLocalLoopback) {
    return `${parsed.protocol}//${parsed.host}`;
  }
  throw new Error(`为保护你的 Google 账号凭证，服务地址仅支持官方 ${DEFAULT_COLAB_ORIGIN}`);
}

function withTimeoutSignal(callerSignal, timeoutMs) {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSig;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([callerSignal, timeoutSig]);
  }
  return callerSignal;
}

export class ColabHttpError extends Error {
  constructor(message, { status = 0, bodyText = "" } = {}) {
    super(message);
    this.name = "ColabHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class ColabControlClient {
  constructor({
    origin = DEFAULT_COLAB_ORIGIN,
    allowLoopbackOrigin = false,
    getAccessToken,
    fetchImpl = defaultFetch,
    requestTimeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  } = {}) {
    this.origin = normalizeColabOrigin(origin, { allowLoopbackOrigin });
    this.getAccessToken = getAccessToken;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async #request(path, { method = "GET", params = {}, headers = {}, signal, timeoutMs = this.requestTimeoutMs } = {}) {
    const reqSignal = withTimeoutSignal(signal, timeoutMs);
    const token = await this.getAccessToken({ signal: reqSignal });
    const url = new URL(path, `${this.origin}/`);
    url.searchParams.set("authuser", "0");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "x-colab-client-agent": CLIENT_AGENT_HEADER,
          ...headers,
        },
        signal: reqSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === "TimeoutError") {
        throw new Error("连接 Google Colab 服务超时，请检查本机网络或代理设置");
      }
      throw new Error("连不上 Google Colab 服务，请检查本机网络或代理设置");
    }

    const rawText = await response.text();
    if (!response.ok) {
      throw new ColabHttpError(`Colab 请求失败 (HTTP ${response.status})`, {
        status: response.status,
        bodyText: rawText.slice(0, 500),
      });
    }

    const stripped = stripXssiPrefix(rawText).trim();
    if (!stripped) return null;
    try {
      return JSON.parse(stripped);
    } catch {
      throw new Error("Google Colab 返回了无法解析的响应，可能是授权已失效，请重新登录");
    }
  }

  async getConsumptionInfo({ signal } = {}) {
    const data = await this.#request("/tun/m/ccu-info", { signal });
    return {
      balance: Number(data?.currentBalance ?? data?.paidComputeUnitsBalance ?? 0),
      hourlyRate: Number(data?.consumptionRateHourly ?? 0),
      assignmentsCount: Number(data?.assignmentsCount ?? 0),
      eligibleGpus: Array.isArray(data?.eligibleGpus) ? data.eligibleGpus : [],
    };
  }

  async listAssignments({ signal } = {}) {
    const data = await this.#request("/tun/m/assignments", { signal });
    const list = Array.isArray(data?.assignments) ? data.assignments : [];
    return list.map((item) => normalizeAssignment(item));
  }

  async assignRuntime({ notebookHash = randomUUID(), accelerator = "G4", highMem = true, signal } = {}) {
    const params = {
      nbh: uuidToWebSafeBase64(notebookHash),
      variant: "GPU",
      accelerator,
    };
    if (highMem && accelerator !== "L4") {
      params.shape = "hm";
    }

    const first = await this.#request("/tun/m/assign", { method: "GET", params, signal });
    if (first?.endpoint && first?.runtimeProxyInfo?.url) {
      return normalizeAssignment({ ...first, accelerator: first.accelerator || accelerator });
    }
    if (!first?.token) {
      throw new Error(`Google Colab 未能为显卡 ${accelerator} 返回分配令牌`);
    }

    const created = await this.#request("/tun/m/assign", {
      method: "POST",
      params,
      headers: { "x-goog-colab-token": String(first.token) },
      signal,
    });
    return normalizeAssignment({ ...created, accelerator: created?.accelerator || accelerator });
  }

  async assignWithFallback({ notebookHash, candidates, signal, onFallback } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("当前显卡档位与所选模型不兼容，请在 Colab 插件设置里调整显卡偏好");
    }
    const failures = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const acc = candidates[i];
      try {
        let assigned = await this.assignRuntime({ notebookHash, accelerator: acc, highMem: true, signal });
        if (!candidates.includes(assigned.accelerator)) {
          await this.unassignRuntime(assigned.endpoint, { signal });
          assigned = await this.assignRuntime({ notebookHash, accelerator: acc, highMem: true, signal });
          if (!candidates.includes(assigned.accelerator)) {
            await this.unassignRuntime(assigned.endpoint, { signal }).catch(() => {});
            throw new Error(`Google Colab 返回了不兼容的显卡档位（${assigned.accelerator}），无法运行当前模型`);
          }
        }
        return assigned;
      } catch (error) {
        if (signal?.aborted) throw error;
        const status = Number(error?.status || 0);
        const retryableTierError =
          status === 400 ||
          status === 403 ||
          status === 404 ||
          status === 409 ||
          status === 412 ||
          status === 429 ||
          status === 503;
        failures.push({ accelerator: acc, status, message: error.message });
        if (!retryableTierError || i === candidates.length - 1) {
          break;
        }
        onFallback?.({ failedAccelerator: acc, nextAccelerator: candidates[i + 1], status });
      }
    }

    const tried = failures.map((f) => f.accelerator).join(" / ");
    const statuses = failures.map((f) => f.status);
    if (statuses.includes(412)) {
      throw new Error(`Google Colab 当前无法分配 ${tried} 显卡（可能是机房库存满或账号已有过多运行中的会话），请先释放闲置会话或稍后再试`);
    }
    if (statuses.includes(400) || statuses.includes(403)) {
      throw new Error(`当前 Google 账号暂无 ${tried} 显卡权限，或计算单元余额不足。请检查 Colab 套餐与剩余计算单元`);
    }
    const firstMsg = failures[0]?.message;
    throw new Error(firstMsg || `分配 Google Colab 显卡（${tried}）失败，请稍后重试`);
  }

  async unassignRuntime(endpoint, { signal } = {}) {
    const clean = String(endpoint ?? "").trim();
    if (!clean) return;
    let first;
    try {
      first = await this.#request(`/tun/m/unassign/${encodeURIComponent(clean)}`, { method: "GET", signal });
    } catch (error) {
      if (Number(error?.status) === 404) return;
      throw error;
    }
    if (!first?.token) return;
    try {
      await this.#request(`/tun/m/unassign/${encodeURIComponent(clean)}`, {
        method: "POST",
        headers: { "x-goog-colab-token": String(first.token) },
        signal,
      });
    } catch (error) {
      if (Number(error?.status) === 404) return;
      throw error;
    }
  }
}

function normalizeAssignment(raw) {
  const proxy = raw?.runtimeProxyInfo ?? {};
  const ttlSec = Number(proxy.tokenExpiresInSeconds ?? 3600);
  return {
    endpoint: String(raw?.endpoint ?? ""),
    accelerator: String(raw?.accelerator ?? "GPU"),
    variant: raw?.variant ?? 1,
    machineShape: raw?.machineShape ?? 1,
    proxyUrl: String(proxy.url ?? "").replace(/\/+$/, ""),
    proxyToken: String(proxy.token ?? ""),
    proxyExpiresAtMs: Date.now() + ttlSec * 1000,
  };
}

function decodeJupyterWsMessage(data) {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  const bytes = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);
  if (bytes.length > 0 && bytes[0] === 0x7b) {
    return JSON.parse(bytes.toString("utf8"));
  }
  if (bytes.length < 12) return null;
  const nbufs = bytes.readUInt32BE(0);
  if (nbufs < 1 || bytes.length < 4 * (nbufs + 1)) return null;
  const jsonStart = bytes.readUInt32BE(4);
  const jsonEnd = nbufs >= 2 ? bytes.readUInt32BE(8) : bytes.length;
  return JSON.parse(bytes.subarray(jsonStart, jsonEnd).toString("utf8"));
}

export class ColabRuntimeProxyClient {
  constructor({ proxyUrl, proxyToken, fetchImpl = defaultFetch, webSocketImpl = DefaultWebSocket } = {}) {
    this.proxyUrl = String(proxyUrl ?? "").replace(/\/+$/, "");
    this.proxyToken = String(proxyToken ?? "");
    this.fetchImpl = fetchImpl;
    this.webSocketImpl = webSocketImpl;
  }

  updateProxy({ proxyUrl, proxyToken }) {
    if (proxyUrl) this.proxyUrl = String(proxyUrl).replace(/\/+$/, "");
    if (proxyToken) this.proxyToken = String(proxyToken);
  }

  #buildUrl(apiPath, extraParams = {}) {
    const url = new URL(`${this.proxyUrl}${apiPath}`);
    url.searchParams.set("authuser", "0");
    url.searchParams.set("colab-runtime-proxy-token", this.proxyToken);
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  #headers(extra = {}) {
    return {
      accept: "application/json",
      "x-colab-client-agent": CLIENT_AGENT_HEADER,
      "x-colab-runtime-proxy-token": this.proxyToken,
      ...extra,
    };
  }

  #contentsApiPath(remotePath) {
    const clean = String(remotePath ?? "")
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `/api/contents/${clean}`;
  }

  async uploadBytes(remotePath, buffer, { signal, timeoutMs = DEFAULT_PROXY_IO_TIMEOUT_MS } = {}) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const filename = String(remotePath).split("/").filter(Boolean).pop() || "file.bin";
    const apiPath = this.#contentsApiPath(remotePath);
    const totalChunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));

    for (let idx = 0; idx < totalChunks; idx += 1) {
      const slice = bytes.subarray(idx * UPLOAD_CHUNK_BYTES, (idx + 1) * UPLOAD_CHUNK_BYTES);
      const chunkNum = totalChunks === 1 ? 1 : idx === totalChunks - 1 ? -1 : idx + 1;
      const payload = {
        name: filename,
        path: String(remotePath).replace(/^\/+/, ""),
        type: "file",
        format: "base64",
        content: slice.toString("base64"),
        chunk: chunkNum,
      };
      const res = await this.fetchImpl(this.#buildUrl(apiPath), {
        method: "PUT",
        headers: this.#headers({ "content-type": "application/json" }),
        body: JSON.stringify(payload),
        signal: withTimeoutSignal(signal, timeoutMs),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new ColabHttpError(`上传文件到云端实例失败 (HTTP ${res.status})`, { status: res.status, bodyText: errText });
      }
    }
  }

  async writeJson(remotePath, value, { signal } = {}) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await this.uploadBytes(remotePath, bytes, { signal, timeoutMs: DEFAULT_PROXY_META_TIMEOUT_MS });
  }

  async downloadBytes(remotePath, { signal, timeoutMs = DEFAULT_PROXY_IO_TIMEOUT_MS, retries = 1 } = {}) {
    const apiPath = this.#contentsApiPath(remotePath);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const res = await this.fetchImpl(this.#buildUrl(apiPath, { content: "1" }), {
          method: "GET",
          headers: this.#headers(),
          signal: withTimeoutSignal(signal, timeoutMs),
        });
        if (res.status === 404) return null;
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new ColabHttpError(`读取云端文件失败 (HTTP ${res.status})`, { status: res.status, bodyText: errText });
        }
        const data = await res.json();
        if (data?.format === "base64") {
          return Buffer.from(String(data.content ?? ""), "base64");
        }
        return Buffer.from(String(data?.content ?? ""), "utf8");
      } catch (err) {
        lastErr = err;
        const status = Number(err?.status || 0);
        const transient = !signal?.aborted && (status === 0 || status === 429 || status === 502 || status === 503 || status === 504);
        if (!transient || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async readJson(remotePath, { signal } = {}) {
    const bytes = await this.downloadBytes(remotePath, { signal, timeoutMs: DEFAULT_PROXY_META_TIMEOUT_MS, retries: 0 });
    if (!bytes) return null;
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
  }

  async deletePath(remotePath, { signal } = {}) {
    const apiPath = this.#contentsApiPath(remotePath);
    const res = await this.fetchImpl(this.#buildUrl(apiPath), {
      method: "DELETE",
      headers: this.#headers(),
      signal: withTimeoutSignal(signal, DEFAULT_PROXY_META_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      throw new ColabHttpError(`清理云端临时文件失败 (HTTP ${res.status})`, { status: res.status });
    }
  }

  async ensureKernel({ signal } = {}) {
    const listRes = await this.fetchImpl(this.#buildUrl("/api/kernels"), {
      method: "GET",
      headers: this.#headers(),
      signal: withTimeoutSignal(signal, DEFAULT_PROXY_META_TIMEOUT_MS),
    });
    if (listRes.ok) {
      const kernels = await listRes.json();
      if (Array.isArray(kernels) && kernels.length > 0 && kernels[0]?.id) {
        return String(kernels[0].id);
      }
    }
    const createRes = await this.fetchImpl(this.#buildUrl("/api/kernels"), {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "python3" }),
      signal: withTimeoutSignal(signal, DEFAULT_PROXY_META_TIMEOUT_MS),
    });
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new ColabHttpError(`启动云端 Python 内核失败 (HTTP ${createRes.status})`, {
        status: createRes.status,
        bodyText: errText,
      });
    }
    const created = await createRes.json();
    if (!created?.id) throw new Error("云端 Python 内核未返回有效编号");
    return String(created.id);
  }

  async executeKernelCode(code, { kernelId, timeoutMs = 45000, signal } = {}) {
    const activeKernelId = kernelId || (await this.ensureKernel({ signal }));
    const sessionId = randomUUID();
    const msgId = randomUUID();

    const httpUrl = new URL(`${this.proxyUrl}/api/kernels/${encodeURIComponent(activeKernelId)}/channels`);
    httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    httpUrl.searchParams.set("session_id", sessionId);
    httpUrl.searchParams.set("authuser", "0");
    httpUrl.searchParams.set("colab-runtime-proxy-token", this.proxyToken);

    const WS = this.webSocketImpl;
    if (typeof WS !== "function") {
      throw new Error("当前运行环境不支持 WebSocket 连接");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let replyReceived = false;
      let idleReceived = false;

      const ws = new WS(httpUrl.toString(), {
        headers: {
          "X-Colab-Client-Agent": CLIENT_AGENT_HEADER,
          "X-Colab-Runtime-Proxy-Token": this.proxyToken,
        },
        signal,
        handshakeTimeoutMs: Math.min(20000, timeoutMs),
      });
      ws.binaryType = "arraybuffer";

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          // ignore close error
        }
      };

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(new Error("连接云端运行环境执行启动指令超时，请重试"));
      }, timeoutMs);

      const onAbort = () => {
        finish(signal.reason || new Error("操作已取消"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      ws.onopen = () => {
        const executeMsg = {
          channel: "shell",
          header: {
            msg_id: msgId,
            username: "beeftv",
            session: sessionId,
            date: new Date().toISOString(),
            msg_type: "execute_request",
            version: "5.3",
          },
          parent_header: {},
          metadata: {},
          content: {
            code,
            silent: false,
            store_history: false,
            user_expressions: {},
            allow_stdin: false,
            stop_on_error: true,
          },
        };
        ws.send(JSON.stringify(executeMsg));
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = decodeJupyterWsMessage(event.data);
        } catch {
          return;
        }
        if (!msg) return;
        const parentId = msg?.parent_header?.msg_id;
        if (parentId !== msgId) return;

        const msgType = msg?.header?.msg_type || msg?.msg_type;
        const content = msg?.content ?? {};

        if (msgType === "stream") {
          if (content.name === "stderr") stderr += String(content.text ?? "");
          else stdout += String(content.text ?? "");
        } else if (msgType === "error") {
          const errLine = `${content.ename || "Error"}: ${content.evalue || "执行出错"}`;
          finish(new Error(`云端环境启动异常：${errLine}`));
          return;
        } else if (msgType === "execute_reply") {
          if (content.status === "error") {
            finish(new Error(`云端环境启动失败：${content.evalue || content.ename || "未知错误"}`));
            return;
          }
          replyReceived = true;
        } else if (msgType === "status" && content.execution_state === "idle") {
          idleReceived = true;
        }

        if (replyReceived && idleReceived) {
          finish(null, { kernelId: activeKernelId, stdout, stderr });
        }
      };

      ws.onerror = () => {
        if (signal?.aborted) {
          finish(signal.reason || new Error("操作已取消"));
          return;
        }
        finish(new Error("连接云端运行环境通道中断，请重试"));
      };

      ws.onclose = () => {
        if (!settled) {
          if (signal?.aborted) {
            finish(signal.reason || new Error("操作已取消"));
          } else if (replyReceived) {
            finish(null, { kernelId: activeKernelId, stdout, stderr });
          } else {
            finish(new Error("云端运行环境连接提前关闭，请重试"));
          }
        }
      };
    });
  }
}
