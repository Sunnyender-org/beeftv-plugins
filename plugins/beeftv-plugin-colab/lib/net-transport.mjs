// 跨平台代理自适应网络传输层（零第三方依赖，纯 Node / Bun 内置模块实现）：
// 自动识别环境变量代理、macOS 系统代理（scutil --proxy）与 Windows 系统代理（注册表 Internet Settings），
// 让桌面端从 Dock / 开始菜单直接启动时也能正常连接 Google OAuth、Colab 控制面与 Jupyter WebSocket。

import { spawnSync } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";

const SYSTEM_PROXY_CACHE_MS = 30 * 1000;
const MAX_REDIRECTS = 5;
const MAX_DECOMPRESSED_HTTP_BYTES = 128 * 1024 * 1024;

let cachedSystemProxy = null;
let cachedSystemProxyAtMs = 0;

function stripIpv6Brackets(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function parseIpv6Groups(rawHost) {
  let host = stripIpv6Brackets(rawHost);
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  if (!host.includes(":")) return null;

  let v4TailGroups = null;
  const lastColon = host.lastIndexOf(":");
  const maybeV4 = host.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!net.isIPv4(maybeV4)) return null;
    const octets = maybeV4.split(".").map((n) => Number(n));
    v4TailGroups = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    host = `${host.slice(0, lastColon)}:0:0`;
  }

  const dblParts = host.split("::");
  if (dblParts.length > 2) return null;
  const parseSide = (s) => (s ? s.split(":") : []);
  const left = parseSide(dblParts[0]);
  const right = dblParts.length === 2 ? parseSide(dblParts[1]) : [];
  const missing = dblParts.length === 2 ? 8 - (left.length + right.length) : 0;
  if ((dblParts.length === 1 && left.length !== 8) || (dblParts.length === 2 && missing < 1)) return null;

  const full = [...left, ...Array(missing).fill("0"), ...right];
  if (full.length !== 8) return null;
  const groups = [];
  for (const seg of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
    groups.push(Number.parseInt(seg, 16));
  }
  if (v4TailGroups) {
    groups[6] = v4TailGroups[0];
    groups[7] = v4TailGroups[1];
  }
  return groups;
}

function groupsToEmbeddedIpv4(groups) {
  const isV4Mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && (groups[5] === 0xffff || groups[5] === 0);
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
  const isLoopbackOrUnspec = groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1);
  if (isLoopbackOrUnspec || (!isV4Mapped && !isNat64)) return null;
  const hi = groups[6];
  const lo = groups[7];
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isLoopbackHost(hostname) {
  const host = stripIpv6Brackets(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIPv4(host)) return host.startsWith("127.");
  const groups = parseIpv6Groups(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  const embeddedV4 = groupsToEmbeddedIpv4(groups);
  return Boolean(embeddedV4 && embeddedV4.startsWith("127."));
}

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateOrLoopbackHost(hostname) {
  const host = stripIpv6Brackets(hostname);
  if (!host) return true;
  if (isLoopbackHost(host)) return true;
  if (net.isIPv4(host)) {
    return isPrivateIpv4(host);
  }
  const groups = parseIpv6Groups(host);
  if (groups) {
    if (groups.every((g) => g === 0)) return true;
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    if ((groups[0] & 0xff00) === 0xff00) return true;
    const embeddedV4 = groupsToEmbeddedIpv4(groups);
    if (embeddedV4) return isPrivateIpv4(embeddedV4);
  }
  return false;
}

function matchesNoProxy(hostname, noProxyRaw) {
  if (isLoopbackHost(hostname)) return true;
  const host = stripIpv6Brackets(hostname);
  if (!host || !noProxyRaw) return false;
  const entries = String(noProxyRaw)
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of entries) {
    if (item === "*") return true;
    if (item === "<local>") {
      if (!host.includes(".") && net.isIP(host) === 0) return true;
      continue;
    }
    const rule = item.replace(/^\*\./, ".").replace(/:\d+$/, "");
    if (!rule) continue;
    if (rule.startsWith(".")) {
      if (host === rule.slice(1) || host.endsWith(rule)) return true;
    } else if (host === rule || host.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

function normalizeProxyCandidate(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname) return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function parseMacScutilProxyOutput(text) {
  const raw = String(text || "");
  const getVal = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(raw);
    return m ? m[1].trim() : "";
  };
  const httpsProxy =
    getVal("HTTPSEnable") === "1" && getVal("HTTPSProxy")
      ? `http://${getVal("HTTPSProxy")}${getVal("HTTPSPort") ? `:${getVal("HTTPSPort")}` : ""}`
      : "";
  const httpProxy =
    getVal("HTTPEnable") === "1" && getVal("HTTPProxy")
      ? `http://${getVal("HTTPProxy")}${getVal("HTTPPort") ? `:${getVal("HTTPPort")}` : ""}`
      : "";
  const excBlock = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/m.exec(raw);
  const exceptions = [];
  if (excBlock) {
    for (const m of excBlock[1].matchAll(/^\s*\d+\s*:\s*(.+)$/gm)) {
      if (m[1]?.trim()) exceptions.push(m[1].trim());
    }
  }
  return {
    httpsProxy: normalizeProxyCandidate(httpsProxy || httpProxy),
    httpProxy: normalizeProxyCandidate(httpProxy || httpsProxy),
    noProxy: exceptions.join(","),
  };
}

export function parseWinRegProxyOutput(text) {
  const raw = String(text || "");
  const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(raw);
  if (!enabledMatch || Number.parseInt(enabledMatch[1], 16) === 0) {
    return { httpsProxy: "", httpProxy: "", noProxy: "" };
  }
  const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(raw);
  if (!serverMatch) return { httpsProxy: "", httpProxy: "", noProxy: "" };
  const overrideMatch = /ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i.exec(raw);
  const noProxy = overrideMatch
    ? overrideMatch[1]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(",")
    : "";
  const serverVal = serverMatch[1].trim();
  if (!serverVal.includes("=")) {
    const single = normalizeProxyCandidate(serverVal);
    return { httpsProxy: single, httpProxy: single, noProxy };
  }
  const map = {};
  for (const part of serverVal.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) map[k.trim().toLowerCase()] = normalizeProxyCandidate(v.trim());
  }
  const httpsProxy = map.https || map.http || "";
  const httpProxy = map.http || map.https || "";
  return { httpsProxy, httpProxy, noProxy };
}

function readOsSystemProxy() {
  if (cachedSystemProxy && Date.now() - cachedSystemProxyAtMs < SYSTEM_PROXY_CACHE_MS) {
    return cachedSystemProxy;
  }
  let detected = { httpsProxy: "", httpProxy: "", noProxy: "" };
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 1200 });
      if (r.status === 0 && r.stdout) {
        detected = parseMacScutilProxyOutput(r.stdout);
      }
    } else if (process.platform === "win32") {
      const regBin = process.env.SYSTEMROOT ? `${process.env.SYSTEMROOT}\\System32\\reg.exe` : "reg";
      const r = spawnSync(
        regBin,
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
        { encoding: "utf8", timeout: 1500, windowsHide: true },
      );
      if (r.status === 0 && r.stdout) {
        detected = parseWinRegProxyOutput(r.stdout);
      }
    }
  } catch {
    detected = { httpsProxy: "", httpProxy: "", noProxy: "" };
  }
  cachedSystemProxy = detected;
  cachedSystemProxyAtMs = Date.now();
  return detected;
}

export function resolveProxyForUrl(targetUrl, { env = process.env, allowSystemLookup = true, systemProxy } = {}) {
  let parsed;
  try {
    parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  } catch {
    return "";
  }
  const noProxy = env?.NO_PROXY || env?.no_proxy || "";
  if (matchesNoProxy(parsed.hostname, noProxy)) {
    return "";
  }
  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const fromEnv = isSecure
    ? env?.HTTPS_PROXY || env?.https_proxy || env?.ALL_PROXY || env?.all_proxy || env?.HTTP_PROXY || env?.http_proxy
    : env?.HTTP_PROXY || env?.http_proxy || env?.ALL_PROXY || env?.all_proxy;
  const normalizedEnv = normalizeProxyCandidate(fromEnv);
  if (normalizedEnv) return normalizedEnv;

  if (!allowSystemLookup && !systemProxy) return "";
  const sys = systemProxy || readOsSystemProxy();
  if (matchesNoProxy(parsed.hostname, sys.noProxy)) {
    return "";
  }
  return isSecure ? sys.httpsProxy : sys.httpProxy;
}

function buildProxyAuthHeader(proxyParsed) {
  if (!proxyParsed.username && !proxyParsed.password) return undefined;
  const raw = `${decodeURIComponent(proxyParsed.username)}:${decodeURIComponent(proxyParsed.password)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function connectDirectSocket(targetUrl, { signal, pinnedAddress } = {}) {
  const isSecureTarget = targetUrl.protocol === "https:" || targetUrl.protocol === "wss:";
  const targetPort = Number(targetUrl.port) || (isSecureTarget ? 443 : 80);
  const cleanHost = stripIpv6Brackets(targetUrl.hostname);
  const connectHost = pinnedAddress ? stripIpv6Brackets(pinnedAddress) : cleanHost;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("操作已取消"));
      return;
    }
    let settled = false;
    let sock = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        sock?.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    const onAbort = () => fail(signal.reason || new Error("操作已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      sock = isSecureTarget
        ? tls.connect({
            host: connectHost,
            port: targetPort,
            servername: net.isIP(cleanHost) ? undefined : cleanHost,
            ALPNProtocols: ["http/1.1"],
          })
        : net.connect({ host: connectHost, port: targetPort });
    } catch (err) {
      fail(err);
      return;
    }

    sock.once("error", fail);
    sock.once(isSecureTarget ? "secureConnect" : "connect", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      sock.removeListener("error", fail);
      resolve(sock);
    });
  });
}

export function connectTunnelSocket(proxyUrl, targetUrl, { signal, pinnedAddress } = {}) {
  if (!proxyUrl) {
    return connectDirectSocket(targetUrl, { signal, pinnedAddress });
  }
  const proxyParsed = new URL(proxyUrl);
  const isSecureTarget = targetUrl.protocol === "https:" || targetUrl.protocol === "wss:";
  const targetPort = Number(targetUrl.port) || (isSecureTarget ? 443 : 80);
  const targetAuthority = `${targetUrl.hostname}:${targetPort}`;
  const cleanHost = stripIpv6Brackets(targetUrl.hostname);
  const proxyTransport = proxyParsed.protocol === "https:" ? https : http;
  const proxyAuth = buildProxyAuthHeader(proxyParsed);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("操作已取消"));
      return;
    }
    let settled = false;
    let activeSocket = null;
    let connectReq = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        connectReq?.socket?.destroy();
        connectReq?.destroy();
      } catch {
        // ignore
      }
      try {
        activeSocket?.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const onAbort = () => fail(signal.reason || new Error("操作已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      connectReq = proxyTransport.request({
        hostname: stripIpv6Brackets(proxyParsed.hostname),
        port: Number(proxyParsed.port) || (proxyParsed.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: targetAuthority,
        agent: false,
        headers: {
          host: targetAuthority,
          ...(proxyAuth ? { "proxy-authorization": proxyAuth } : {}),
        },
      });
    } catch (err) {
      fail(err);
      return;
    }

    connectReq.once("error", fail);
    connectReq.once("connect", (res, rawSocket, head) => {
      activeSocket = rawSocket;
      if (res.statusCode !== 200) {
        fail(new Error(`本地代理连接目标失败（HTTP ${res.statusCode}）`));
        return;
      }
      if (head && head.length > 0) {
        rawSocket.unshift(head);
      }
      if (!isSecureTarget) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(rawSocket);
        return;
      }
      try {
        const tlsSocket = tls.connect({
          socket: rawSocket,
          host: cleanHost,
          servername: net.isIP(cleanHost) ? undefined : cleanHost,
          ALPNProtocols: ["http/1.1"],
        });
        activeSocket = tlsSocket;
        tlsSocket.once("error", fail);
        tlsSocket.once("secureConnect", () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          tlsSocket.removeListener("error", fail);
          resolve(tlsSocket);
        });
      } catch (err) {
        fail(err);
      }
    });

    connectReq.end();
  });
}

export function normalizeBodyBuffer(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body), "utf8");
}

function decompressResponseBuffer(buf, contentEncoding) {
  const enc = String(contentEncoding || "").trim().toLowerCase();
  if (!enc || buf.length === 0) return buf;
  if (enc === "gzip" || enc === "x-gzip") {
    return zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_HTTP_BYTES });
  }
  if (enc === "deflate") {
    return zlib.inflateSync(buf, { maxOutputLength: MAX_DECOMPRESSED_HTTP_BYTES });
  }
  if (enc === "br") {
    return zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_DECOMPRESSED_HTTP_BYTES });
  }
  return buf;
}

function stripCrossOriginSensitiveHeaders(headers) {
  const next = new Headers(headers);
  const toDelete = [];
  next.forEach((_val, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "proxy-authorization" ||
      lower === "x-api-key" ||
      lower === "x-colab-runtime-proxy-token" ||
      lower === "x-colab-client-agent" ||
      lower.startsWith("x-goog-") ||
      lower.startsWith("sec-")
    ) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) {
    next.delete(key);
  }
  return next;
}

async function fetchSingleHopViaTunnel(urlObj, init = {}, proxyUrl) {
  const method = String(init.method || "GET").toUpperCase();
  const reqHeaders = new Headers(init.headers || {});
  if (!reqHeaders.has("accept-encoding") && method !== "HEAD") {
    reqHeaders.set("accept-encoding", "gzip, deflate, br");
  }
  const bodyBuf = method === "GET" || method === "HEAD" ? null : normalizeBodyBuffer(init.body);
  if (bodyBuf && !reqHeaders.has("content-length")) {
    reqHeaders.set("content-length", String(bodyBuf.length));
  }

  const tunnelSocket = await connectTunnelSocket(proxyUrl, urlObj, {
    signal: init.signal,
    pinnedAddress: init.pinnedAddress,
  });
  const defaultPort = urlObj.protocol === "https:" ? "443" : "80";
  const hostHeader = urlObj.port && urlObj.port !== defaultPort
    ? `${urlObj.hostname}:${urlObj.port}`
    : urlObj.hostname;
  const plainHeaders = { host: hostHeader, connection: "close" };
  reqHeaders.forEach((value, key) => {
    plainHeaders[key] = value;
  });

  const rawResp = await new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", onAbort);
      try {
        req?.destroy();
      } catch {
        // ignore
      }
      try {
        tunnelSocket.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    const onAbort = () => fail(init.signal.reason || new Error("操作已取消"));
    if (init.signal) {
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
    }

    const isHttps = urlObj.protocol === "https:";
    const agent = isHttps ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    agent.createConnection = () => tunnelSocket;
    const requestFn = isHttps ? https.request : http.request;

    try {
      req = requestFn(
        {
          hostname: stripIpv6Brackets(urlObj.hostname),
          port: urlObj.port || Number(defaultPort),
          path: `${urlObj.pathname}${urlObj.search}`,
          method,
          headers: plainHeaders,
          agent,
        },
        (res) => {
          const chunks = [];
          let receivedBytes = 0;
          res.on("data", (c) => {
            receivedBytes += c.length;
            if (receivedBytes > MAX_DECOMPRESSED_HTTP_BYTES) {
              fail(new Error("响应内容超出安全大小上限"));
              return;
            }
            chunks.push(c);
          });
          res.once("error", fail);
          res.once("end", () => {
            if (settled) return;
            settled = true;
            init.signal?.removeEventListener("abort", onAbort);
            try {
              tunnelSocket.destroy();
            } catch {
              // ignore
            }
            resolve({
              status: res.statusCode || 200,
              statusText: res.statusMessage || "",
              headers: res.headers,
              rawBody: Buffer.concat(chunks),
            });
          });
        },
      );
      req.once("error", fail);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    } catch (err) {
      fail(err);
    }
  });

  const hadContentEncoding = Boolean(rawResp.headers["content-encoding"]) && method !== "HEAD";
  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(rawResp.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower === "transfer-encoding") continue;
    if (hadContentEncoding && (lower === "content-encoding" || lower === "content-length")) continue;
    if (Array.isArray(v)) {
      for (const item of v) respHeaders.append(k, item);
    } else {
      respHeaders.set(k, String(v));
    }
  }
  const decoded = method === "HEAD"
    ? Buffer.alloc(0)
    : decompressResponseBuffer(rawResp.rawBody, rawResp.headers["content-encoding"]);
  const nullBodyStatus = rawResp.status === 204 || rawResp.status === 205 || rawResp.status === 304 || method === "HEAD";
  return new Response(nullBodyStatus ? null : decoded, {
    status: rawResp.status,
    statusText: rawResp.statusText,
    headers: respHeaders,
  });
}

async function validatePublicHostAndResolve(urlObj, proxyUrl, lookupFn, errorMessage) {
  if (isPrivateOrLoopbackHost(urlObj.hostname)) {
    throw new Error(errorMessage);
  }
  const cleanHost = stripIpv6Brackets(urlObj.hostname);
  if (net.isIP(cleanHost) !== 0) {
    return "";
  }
  let list = [];
  try {
    const resolved = await lookupFn(cleanHost, { all: true });
    list = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    throw new Error(errorMessage);
  }
  if (list.length === 0 || list.some((r) => !r?.address || isPrivateOrLoopbackHost(r.address))) {
    throw new Error(errorMessage);
  }
  return proxyUrl ? "" : String(list[0].address);
}

export async function defaultFetch(input, init = {}) {
  const isReq = input instanceof Request;
  const initialUrlStr = isReq ? input.url : String(input);
  const explicitProxyUrl = init.proxyUrl;
  const requirePublicTarget = Boolean(init.requirePublicTarget);

  let currentMethod = String(init.method || (isReq ? input.method : "GET") || "GET").toUpperCase();
  let currentHeaders = new Headers(init.headers || (isReq ? input.headers : undefined) || {});
  const redirectMode = init.redirect || (isReq ? input.redirect : undefined) || "follow";
  const signal = init.signal || (isReq ? input.signal : undefined);

  let currentBody = init.body;
  if (currentBody === undefined && isReq && currentMethod !== "GET" && currentMethod !== "HEAD") {
    const ab = await input.arrayBuffer();
    if (ab.byteLength > 0) {
      currentBody = Buffer.from(ab);
    }
  }

  const lookupFn = typeof init.lookup === "function" ? init.lookup : dns.promises.lookup;
  let currentUrl = new URL(initialUrlStr);
  let pinnedAddress = "";

  const computeProxy = (urlObj) =>
    explicitProxyUrl !== undefined
      ? isLoopbackHost(urlObj.hostname)
        ? ""
        : explicitProxyUrl
      : resolveProxyForUrl(urlObj);

  if (requirePublicTarget) {
    pinnedAddress = await validatePublicHostAndResolve(
      currentUrl,
      computeProxy(currentUrl),
      lookupFn,
      "拒绝访问内网或本机回环地址",
    );
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const activeProxy = computeProxy(currentUrl);

    const hopInit = {
      method: currentMethod,
      headers: currentHeaders,
      body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
      redirect: "manual",
      signal,
      pinnedAddress,
    };

    const res = activeProxy || pinnedAddress
      ? await fetchSingleHopViaTunnel(currentUrl, hopInit, activeProxy)
      : await fetch(currentUrl.toString(), hopInit);

    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    const location = res.headers.get("location");
    if (!isRedirect || !location || redirectMode === "manual") {
      return res;
    }
    if (redirectMode === "error") {
      throw new Error(`网络请求被拒绝跟随重定向（HTTP ${res.status}）`);
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("网络请求重定向次数过多");
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new Error("拒绝重定向到不受支持的协议");
    }
    if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
      throw new Error("拒绝从 HTTPS 降级到明文 HTTP 的重定向");
    }

    const isCrossOrigin = nextUrl.origin !== currentUrl.origin;
    const willRewriteToGet =
      res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST");
    const hasOutgoingBody =
      currentMethod !== "GET" && currentMethod !== "HEAD" && currentBody !== undefined && currentBody !== null;

    if (isCrossOrigin && !willRewriteToGet && hasOutgoingBody) {
      throw new Error("拒绝跨源转发包含请求体的重定向");
    }

    const nextProxy = computeProxy(nextUrl);
    const nextPinnedAddress = await validatePublicHostAndResolve(
      nextUrl,
      nextProxy,
      lookupFn,
      "拒绝重定向至内网或本机回环地址",
    );

    if (isCrossOrigin) {
      currentHeaders = stripCrossOriginSensitiveHeaders(currentHeaders);
    }

    if (willRewriteToGet) {
      currentMethod = "GET";
      currentBody = undefined;
      currentHeaders.delete("content-length");
      currentHeaders.delete("content-type");
      currentHeaders.delete("content-encoding");
      currentHeaders.delete("content-language");
      currentHeaders.delete("content-location");
    }

    currentUrl = nextUrl;
    pinnedAddress = nextPinnedAddress;
  }

  throw new Error("网络请求重定向次数过多");
}
