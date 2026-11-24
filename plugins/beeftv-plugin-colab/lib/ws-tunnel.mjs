// RFC 6455 WebSocket 代理隧道客户端（零第三方依赖，支持自定义握手头、信号取消、握手超时与大帧分片重组）。

import { createHash, randomBytes } from "node:crypto";
import { connectTunnelSocket, normalizeBodyBuffer, resolveProxyForUrl } from "./net-transport.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 20 * 1000;
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

function encodeClientWsFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen = 4;
  else if (len >= 65536) headerLen = 10;

  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  mask.copy(frame, headerLen);
  for (let i = 0; i < len; i += 1) {
    frame[headerLen + 4 + i] = payloadBuf[i] ^ mask[i & 3];
  }
  return frame;
}

class TunneledWebSocket {
  constructor(url, options = {}) {
    this.url = String(url);
    this.binaryType = "arraybuffer";
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    this.#socket = null;
    this.#recvBuf = Buffer.alloc(0);
    this.#fragOpcode = 0;
    this.#fragChunks = [];
    this.#fragBytes = 0;
    this.#closed = false;
    this.#maxPayloadBytes = Number(options.maxPayloadBytes) > 0
      ? Number(options.maxPayloadBytes)
      : DEFAULT_WS_MAX_PAYLOAD_BYTES;
    this.#abortController = new AbortController();

    const handshakeTimeoutMs = Number(options.handshakeTimeoutMs) > 0
      ? Number(options.handshakeTimeoutMs)
      : DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
    this.#handshakeTimer = setTimeout(() => {
      const err = new Error("WebSocket 握手超时");
      this.#abortController.abort(err);
      this.#fail(err);
    }, handshakeTimeoutMs);
    this.#handshakeTimer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) {
        const reason = options.signal.reason || new Error("操作已取消");
        this.#abortController.abort(reason);
        queueMicrotask(() => this.#fail(reason));
        return;
      }
      this.#externalAbortHandler = () => {
        const reason = options.signal.reason || new Error("操作已取消");
        this.#abortController.abort(reason);
        this.#fail(reason);
      };
      this.#externalSignal = options.signal;
      this.#externalSignal.addEventListener("abort", this.#externalAbortHandler, { once: true });
    }

    const targetUrl = new URL(this.url);
    const proxyUrl = options.proxyUrl !== undefined ? options.proxyUrl : resolveProxyForUrl(targetUrl);
    void this.#connect(targetUrl, proxyUrl, options.headers || {});
  }

  #socket;
  #recvBuf;
  #fragOpcode;
  #fragChunks;
  #fragBytes;
  #closed;
  #maxPayloadBytes;
  #abortController;
  #handshakeTimer;
  #externalSignal;
  #externalAbortHandler;

  #clearHandshakeTimer() {
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }

  #clearAllGuards() {
    this.#clearHandshakeTimer();
    if (this.#externalSignal && this.#externalAbortHandler) {
      this.#externalSignal.removeEventListener("abort", this.#externalAbortHandler);
      this.#externalAbortHandler = null;
    }
  }

  async #connect(targetUrl, proxyUrl, extraHeaders) {
    try {
      const sock = await connectTunnelSocket(proxyUrl, targetUrl, {
        signal: this.#abortController.signal,
      });
      if (this.#closed) {
        sock.destroy();
        return;
      }
      this.#socket = sock;
      const secKey = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1").update(secKey + WS_GUID).digest("base64");
      const defaultPort = targetUrl.protocol === "wss:" ? "443" : "80";
      const hostHeader = targetUrl.port && targetUrl.port !== defaultPort
        ? `${targetUrl.hostname}:${targetUrl.port}`
        : targetUrl.hostname;

      const lines = [
        `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
        `Host: ${hostHeader}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${secKey}`,
        "Sec-WebSocket-Version: 13",
      ];
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
      }
      lines.push("", "");
      sock.write(lines.join("\r\n"));

      let handshakeDone = false;
      let headerBuf = Buffer.alloc(0);

      sock.on("data", (chunk) => {
        if (!handshakeDone) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const sepIdx = headerBuf.indexOf("\r\n\r\n");
          if (sepIdx === -1) {
            if (headerBuf.length > 32768) this.#fail(new Error("WebSocket 握手头超限"));
            return;
          }
          const rawHeaderText = headerBuf.subarray(0, sepIdx).toString("latin1");
          const rest = headerBuf.subarray(sepIdx + 4);
          headerBuf = Buffer.alloc(0);
          const statusLine = rawHeaderText.split("\r\n")[0] || "";
          const acceptMatch = /^sec-websocket-accept:\s*(.+)$/im.exec(rawHeaderText);
          if (!/^HTTP\/1\.[01]\s+101\b/.test(statusLine) || !acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
            this.#fail(new Error(`WebSocket 握手未通过（${statusLine || "未知状态"}）`));
            return;
          }
          handshakeDone = true;
          this.#clearHandshakeTimer();
          this.readyState = 1;
          this.onopen?.({});
          if (rest.length > 0) {
            this.#onFrameBytes(rest);
          }
          return;
        }
        this.#onFrameBytes(chunk);
      });

      sock.once("error", (err) => this.#fail(err));
      sock.once("close", () => {
        this.#clearAllGuards();
        if (this.#closed) return;
        this.#closed = true;
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
      });
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err) {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearAllGuards();
    this.readyState = 3;
    try {
      this.#socket?.destroy();
    } catch {
      // ignore
    }
    this.onerror?.({ error: err, message: err?.message || "连接异常" });
    this.onclose?.({ code: 1006 });
  }

  #onFrameBytes(chunk) {
    this.#recvBuf = this.#recvBuf.length === 0 ? chunk : Buffer.concat([this.#recvBuf, chunk]);
    while (this.#recvBuf.length >= 2 && !this.#closed) {
      const b0 = this.#recvBuf[0];
      const b1 = this.#recvBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.#recvBuf.length < 4) return;
        payloadLen = this.#recvBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.#recvBuf.length < 10) return;
        const bigLen = this.#recvBuf.readBigUInt64BE(2);
        if (bigLen > BigInt(this.#maxPayloadBytes)) {
          this.#fail(new Error("WebSocket 消息帧体积超出安全上限"));
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.#maxPayloadBytes) {
        this.#fail(new Error("WebSocket 消息帧体积超出安全上限"));
        return;
      }

      let maskKey = null;
      if (isMasked) {
        if (this.#recvBuf.length < offset + 4) return;
        maskKey = this.#recvBuf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.#recvBuf.length < offset + payloadLen) return;
      const payload = Buffer.from(this.#recvBuf.subarray(offset, offset + payloadLen));
      this.#recvBuf = this.#recvBuf.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x09) {
        if (this.readyState === 1) this.#socket?.write(encodeClientWsFrame(0x0a, payload));
        continue;
      }
      if (opcode === 0x0a) continue;
      if (opcode === 0x08) {
        this.close();
        return;
      }

      if (opcode === 0x01 || opcode === 0x02) {
        this.#fragOpcode = opcode;
        this.#fragChunks = [payload];
        this.#fragBytes = payload.length;
      } else if (opcode === 0x00 && this.#fragOpcode !== 0) {
        this.#fragBytes += payload.length;
        if (this.#fragBytes > this.#maxPayloadBytes) {
          this.#fail(new Error("WebSocket 分片消息体积超出安全上限"));
          return;
        }
        this.#fragChunks.push(payload);
      }

      if (fin && this.#fragOpcode !== 0) {
        const merged = this.#fragChunks.length === 1 ? this.#fragChunks[0] : Buffer.concat(this.#fragChunks);
        const doneOp = this.#fragOpcode;
        this.#fragOpcode = 0;
        this.#fragChunks = [];
        this.#fragBytes = 0;
        if (doneOp === 0x01) {
          this.onmessage?.({ data: merged.toString("utf8") });
        } else {
          const out =
            this.binaryType === "arraybuffer"
              ? merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength)
              : merged;
          this.onmessage?.({ data: out });
        }
      }
    }
  }

  send(data) {
    if (this.readyState !== 1 || !this.#socket) {
      throw new Error("WebSocket 尚未建立连接");
    }
    if (typeof data === "string") {
      this.#socket.write(encodeClientWsFrame(0x01, Buffer.from(data, "utf8")));
    } else {
      this.#socket.write(encodeClientWsFrame(0x02, normalizeBodyBuffer(data)));
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearAllGuards();
    const wasOpen = this.readyState === 1;
    const sock = this.#socket;
    this.readyState = 3;
    this.#abortController.abort(new Error("WebSocket 已关闭"));
    try {
      if (wasOpen && sock) {
        sock.write(encodeClientWsFrame(0x08, Buffer.alloc(0)));
      }
      sock?.end();
      if (sock) {
        setTimeout(() => {
          try {
            sock.destroy();
          } catch {
            // ignore
          }
        }, 250).unref?.();
      }
    } catch {
      // ignore
    }
    this.onclose?.({ code: 1000 });
  }
}

export function DefaultWebSocket(url, options = {}) {
  const proxyUrl = options.proxyUrl !== undefined ? options.proxyUrl : resolveProxyForUrl(url);
  return new TunneledWebSocket(url, { ...options, proxyUrl });
}
