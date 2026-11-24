// 本机回环状态与原图传输服务（仅绑定 127.0.0.1，允许桌面端 WebView 与本机开发源，拒绝跨站及空来源）。

import { randomBytes } from "node:crypto";
import { chmodSync, createReadStream, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { CONTROL_CLIENT_HEADER, CONTROL_SERVER_PORTS, GPU_PREFERENCES, PLUGIN_ID } from "./constants.mjs";

const MAX_LOCAL_MEDIA_FILES = 60;
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
const MEDIA_TOKEN_RE = /^[a-f0-9]{32}\.png$/;

export function isAllowedLocalOrigin(originHeader) {
  if (!originHeader) return true;
  const raw = String(originHeader).trim();
  if (!raw || raw === "null" || raw.startsWith("file:")) {
    return false;
  }
  if (raw.startsWith("wails://") || raw.startsWith("app://")) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "wails.localhost"
    );
  } catch {
    return false;
  }
}

export class ColabLocalControlServer {
  constructor({ mediaDir, controlPorts = CONTROL_SERVER_PORTS, handlers } = {}) {
    this.mediaDir = mediaDir;
    this.controlPorts = controlPorts;
    this.handlers = handlers;
    this.mediaTokens = new Map();
    this.httpServer = null;
    this.serverPort = 0;
    this.serverStartPromise = null;
    this.#sweepExpiredMedia();
  }

  #sweepExpiredMedia() {
    if (!this.mediaDir || !existsSync(this.mediaDir)) return;
    const cutoff = Date.now() - MEDIA_RETENTION_MS;
    try {
      for (const name of readdirSync(this.mediaDir)) {
        if (!MEDIA_TOKEN_RE.test(name)) continue;
        const full = join(this.mediaDir, name);
        try {
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full, { force: true });
          }
        } catch {
          // ignore race
        }
      }
    } catch {
      // ignore unreadable dir
    }
  }

  async ensureStarted() {
    if (this.serverPort > 0 && this.httpServer) return this.serverPort;
    if (this.serverStartPromise) return this.serverStartPromise;
    this.serverStartPromise = this.#bindFirstAvailablePort().finally(() => {
      this.serverStartPromise = null;
    });
    return this.serverStartPromise;
  }

  async close() {
    if (!this.httpServer) return;
    const srv = this.httpServer;
    this.httpServer = null;
    this.serverPort = 0;
    await new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
  }

  async registerOutputImage(pngBytes, originalName) {
    const port = await this.ensureStarted();
    const token = `${randomBytes(16).toString("hex")}.png`;
    const localPath = join(this.mediaDir, token);
    writeFileSync(localPath, pngBytes, { mode: 0o600 });
    try {
      chmodSync(localPath, 0o600);
    } catch {
      // Windows 文件系统忽略 POSIX 权限位。
    }
    this.mediaTokens.set(token, localPath);
    if (this.mediaTokens.size > MAX_LOCAL_MEDIA_FILES) {
      const oldestKey = this.mediaTokens.keys().next().value;
      const oldestPath = this.mediaTokens.get(oldestKey);
      this.mediaTokens.delete(oldestKey);
      if (oldestPath && existsSync(oldestPath)) {
        rmSync(oldestPath, { force: true });
      }
    }
    const cleanLabel = String(originalName || token).replace(/[^\w.-]/g, "");
    return `http://127.0.0.1:${port}/media/${token}?name=${encodeURIComponent(cleanLabel)}`;
  }

  #resolveMediaFilePath(token) {
    if (!MEDIA_TOKEN_RE.test(token)) return null;
    const cached = this.mediaTokens.get(token);
    if (cached && existsSync(cached)) return cached;
    const diskPath = join(this.mediaDir, token);
    if (existsSync(diskPath)) return diskPath;
    return null;
  }

  async #bindFirstAvailablePort() {
    const candidates = [...this.controlPorts, 0];
    for (const candidatePort of candidates) {
      try {
        const port = await new Promise((resolve, reject) => {
          const srv = createServer((req, res) => {
            this.#handleHttpRequest(req, res).catch((err) => {
              const status = Number(err?.httpStatus) || 500;
              if (!res.headersSent) {
                res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
              }
              res.end(
                JSON.stringify({
                  ok: false,
                  service: PLUGIN_ID,
                  message: err?.message || "内部处理错误",
                }),
              );
            });
          });
          srv.once("error", reject);
          srv.listen(candidatePort, "127.0.0.1", () => {
            srv.removeListener("error", reject);
            srv.unref();
            this.httpServer = srv;
            const addr = srv.address();
            resolve(typeof addr === "object" && addr ? addr.port : candidatePort);
          });
        });
        this.serverPort = port;
        return port;
      } catch {
        // 端口已被占用时继续尝试下一个候选端口。
      }
    }
    throw new Error("无法启动本机回环状态服务");
  }

  #setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && isAllowedLocalOrigin(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("access-control-allow-private-network", "true");
    }
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", `content-type, ${CONTROL_CLIENT_HEADER}`);
  }

  async #readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 256 * 1024) throw new Error("请求体积超出限制");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }

  #sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ service: PLUGIN_ID, ...payload }));
  }

  async #handleHttpRequest(req, res) {
    this.#setCorsHeaders(req, res);
    if (!isAllowedLocalOrigin(req.headers.origin)) {
      this.#sendJson(res, 403, { ok: false, message: "拒绝不受信任的跨站来源访问" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${this.serverPort || 18971}`);

    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const token = url.pathname.slice("/media/".length);
      const filePath = this.#resolveMediaFilePath(token);
      if (!filePath) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      await new Promise((resolve) => {
        const stream = createReadStream(filePath);
        stream.once("open", () => {
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "private, max-age=3600",
          });
          stream.pipe(res);
        });
        stream.once("error", () => {
          if (!res.headersSent) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("Not Found");
          } else {
            res.destroy();
          }
          resolve();
        });
        res.once("close", resolve);
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.headers[CONTROL_CLIENT_HEADER] !== "1") {
        this.#sendJson(res, 403, { ok: false, message: "缺少客户端校验头" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const status = await this.handlers.onGetStatus({ forceRefresh });
        this.#sendJson(res, 200, { ok: true, data: status });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await this.#readJsonBody(req);
        const patch = {};
        if (typeof body.gpuPreference === "string" && GPU_PREFERENCES.includes(body.gpuPreference)) {
          patch.gpuPreference = body.gpuPreference;
        }
        if (body.idleStopMinutes !== undefined) {
          const mins = Number(body.idleStopMinutes);
          if (Number.isFinite(mins) && mins >= 0 && mins <= 180) {
            patch.idleStopMinutes = Math.round(mins);
          }
        }
        const status = await this.handlers.onUpdateSettings(patch);
        this.#sendJson(res, 200, { ok: true, data: status });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        const body = await this.#readJsonBody(req);
        const status = await this.handlers.onStop({ releaseAll: Boolean(body.releaseAll) });
        this.#sendJson(res, 200, { ok: true, data: status });
        return;
      }
    }

    this.#sendJson(res, 404, { ok: false, message: "未找到接口" });
  }
}
