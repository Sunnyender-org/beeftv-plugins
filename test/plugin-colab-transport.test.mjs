import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  defaultFetch,
  isLoopbackHost,
  isPrivateOrLoopbackHost,
  parseMacScutilProxyOutput,
  parseWinRegProxyOutput,
  resolveProxyForUrl,
} from "../plugins/beeftv-plugin-colab/lib/net-transport.mjs";
import { readReferenceImages } from "../plugins/beeftv-plugin-colab/lib/task-store.mjs";
import { DefaultWebSocket } from "../plugins/beeftv-plugin-colab/lib/ws-tunnel.mjs";

test("parses macOS scutil / Windows Registry proxy configs, default ports, bypass lists, and reserved IPs", () => {
  const macParsed = parseMacScutilProxyOutput(
    "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.corp.internal\n    1 : intranet\n  }\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}",
  );
  assert.deepEqual(macParsed, {
    httpsProxy: "http://127.0.0.1:7890",
    httpProxy: "http://127.0.0.1:7890",
    noProxy: "*.corp.internal,intranet",
  });
  assert.deepEqual(parseMacScutilProxyOutput("<dictionary> {\n  HTTPSEnable : 0\n}"), {
    httpsProxy: "",
    httpProxy: "",
    noProxy: "",
  });

  const winParsed = parseWinRegProxyOutput(
    "    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:10809\r\n    ProxyOverride    REG_SZ    *.corp.local;<local>\r\n",
  );
  assert.deepEqual(winParsed, {
    httpsProxy: "http://127.0.0.1:10809",
    httpProxy: "http://127.0.0.1:10809",
    noProxy: "*.corp.local,<local>",
  });
  assert.deepEqual(
    parseWinRegProxyOutput(
      "    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443\r\n",
    ),
    { httpsProxy: "http://127.0.0.1:8443", httpProxy: "http://127.0.0.1:8080", noProxy: "" },
  );
  assert.deepEqual(
    parseWinRegProxyOutput("    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n"),
    { httpsProxy: "", httpProxy: "", noProxy: "" },
  );

  for (const loopbackVariant of [
    "localhost",
    "localhost.",
    "sub.localhost.",
    "127.0.0.1",
    "[::1]",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[0:0:0:0:0:ffff:7f00:1]",
  ]) {
    assert.equal(isLoopbackHost(loopbackVariant), true);
    assert.equal(isPrivateOrLoopbackHost(loopbackVariant), true);
  }
  for (const privateVariant of [
    "10.0.0.8",
    "172.16.5.4",
    "192.168.1.2",
    "169.254.169.254",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "[::ffff:a9fe:a9fe]",
    "[fd00::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[64:ff9b::7f00:1]",
  ]) {
    assert.equal(isPrivateOrLoopbackHost(privateVariant), true);
  }
  assert.equal(isPrivateOrLoopbackHost("8.8.8.8"), false);
  assert.equal(isPrivateOrLoopbackHost("colab.research.google.com"), false);

  const env = { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: ".internal.example,direct.org" };
  assert.equal(resolveProxyForUrl("https://oauth2.googleapis.com/token", { env, allowSystemLookup: false }), "http://127.0.0.1:7890");
  assert.equal(resolveProxyForUrl("http://localhost.:18971/api/status", { env, allowSystemLookup: false }), "");
  assert.equal(resolveProxyForUrl("https://api.internal.example/v1", { env, allowSystemLookup: false }), "");
  assert.equal(resolveProxyForUrl("https://sub.direct.org/v1", { env, allowSystemLookup: false }), "");

  assert.equal(
    resolveProxyForUrl("https://oauth2.googleapis.com/token", {
      env: { HTTPS_PROXY: "http://proxy.example.com" },
      allowSystemLookup: false,
    }),
    "http://proxy.example.com",
  );
  assert.equal(
    resolveProxyForUrl("https://oauth2.googleapis.com/token", {
      env: { HTTPS_PROXY: "http://proxy.example.com:80" },
      allowSystemLookup: false,
    }),
    "http://proxy.example.com",
  );
  assert.equal(
    resolveProxyForUrl("https://oauth2.googleapis.com/token", {
      env: { HTTPS_PROXY: "https://proxy.example.com:443" },
      allowSystemLookup: false,
    }),
    "https://proxy.example.com",
  );

  assert.equal(resolveProxyForUrl("https://git.corp.internal/repo", { env: {}, allowSystemLookup: false, systemProxy: macParsed }), "");
  assert.equal(resolveProxyForUrl("http://fileserver/share", { env: {}, allowSystemLookup: false, systemProxy: winParsed }), "");
  assert.equal(
    resolveProxyForUrl("https://colab.research.google.com/tun/m/assignments", { env: {}, allowSystemLookup: false, systemProxy: winParsed }),
    "http://127.0.0.1:10809",
  );
});

test("tunnels HTTP fetch (POST gzip, Request instance body, HEAD content-length) and WebSocket with custom headers", async () => {
  const connectTargets = [];
  const openSockets = new Set();
  const trackSocket = (sock) => {
    openSockets.add(sock);
    sock.once("close", () => openSockets.delete(sock));
  };
  let seenWsHeader = "";

  const originServer = http.createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": "4096", "x-linked-size": "4096" });
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") })));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gz);
    });
  });

  originServer.on("upgrade", (req, socket) => {
    trackSocket(socket);
    seenWsHeader = String(req.headers["x-colab-runtime-proxy-token"] || "");
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once("data", (frame) => {
      const masked = (frame[1] & 0x80) !== 0;
      const len = frame[1] & 0x7f;
      const mask = masked ? frame.subarray(2, 6) : Buffer.alloc(4);
      const payload = Buffer.from(frame.subarray(masked ? 6 : 2, (masked ? 6 : 2) + len));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      const reply = Buffer.from(`ack:${payload.toString("utf8")}`, "utf8");
      const out = Buffer.alloc(2 + reply.length);
      out[0] = 0x81;
      out[1] = reply.length;
      reply.copy(out, 2);
      socket.write(out);
    });
  });

  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    trackSocket(clientSocket);
    connectTargets.push(String(req.url));
    const [, portStr] = String(req.url).split(":");
    const upstream = net.connect(Number(portStr), "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    trackSocket(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise((r) => originServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r));
  const originPort = originServer.address().port;
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  try {
    const headRes = await defaultFetch(`http://example.invalid:${originPort}/weights.safetensors`, {
      method: "HEAD",
      proxyUrl,
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("content-length"), "4096");

    const reqObj = new Request(`http://example.invalid:${originPort}/echo`, {
      method: "POST",
      body: "request-body-preserved",
    });
    const reqRes = await defaultFetch(reqObj, { proxyUrl });
    assert.equal(reqRes.status, 200);
    assert.deepEqual(await reqRes.json(), { echoed: "request-body-preserved" });

    const wsReply = await new Promise((resolve, reject) => {
      const ws = DefaultWebSocket(`ws://example.invalid:${originPort}/api/kernels/1/channels`, {
        proxyUrl,
        headers: { "X-Colab-Runtime-Proxy-Token": "tok_xyz_987" },
      });
      ws.onerror = (e) => reject(new Error(e?.message || "ws error"));
      ws.onopen = () => ws.send("execute_request");
      ws.onmessage = (ev) => {
        ws.close();
        resolve(String(ev.data));
      };
    });
    assert.equal(seenWsHeader, "tok_xyz_987");
    assert.equal(wsReply, "ack:execute_request");
    assert.ok(connectTargets.length >= 3);
  } finally {
    for (const sock of openSockets) sock.destroy();
    originServer.close();
    originServer.closeAllConnections?.();
    proxyServer.close();
    proxyServer.closeAllConnections?.();
  }
});

test("blocks SSRF redirects, DNS rebinding, PUT 301 body leaks, self-signed TLS, and oversized WS frames", async () => {
  const openSockets = new Set();
  const trackSocket = (sock) => {
    openSockets.add(sock);
    sock.once("close", () => openSockets.delete(sock));
  };
  let targetHeaders = {};
  let targetMethod = "";
  let targetBody = "";
  let pendingProxySocketDestroyed = false;

  const siteB = http.createServer((req, res) => {
    targetHeaders = req.headers;
    targetMethod = req.method || "";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      targetBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  let siteBPort = 0;
  const siteA = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://a.example.invalid");
    const mode = url.searchParams.get("mode");
    if (mode === "localhost_dot") {
      res.writeHead(302, { location: `http://localhost.:${siteBPort}/ssrf` });
      res.end();
      return;
    }
    if (mode === "v6_mapped_hex") {
      res.writeHead(302, { location: `http://[::ffff:7f00:1]:${siteBPort}/ssrf` });
      res.end();
      return;
    }
    if (mode === "v6_mapped_dotted") {
      res.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${siteBPort}/ssrf` });
      res.end();
      return;
    }
    if (mode === "dns_rebind") {
      res.writeHead(302, { location: `http://rebind.attacker.invalid:${siteBPort}/ssrf` });
      res.end();
      return;
    }
    if (mode === "same_origin_rebind") {
      res.writeHead(302, { location: "/internal-secret" });
      res.end();
      return;
    }
    if (mode === "unresolvable_redirect") {
      res.writeHead(302, { location: `http://corp-internal.only:${siteBPort}/admin` });
      res.end();
      return;
    }
    if (mode === "307body") {
      res.writeHead(307, { location: `http://b.example.invalid:${siteBPort}/sink` });
      res.end();
      return;
    }
    if (mode === "301put") {
      res.writeHead(301, { location: `http://b.example.invalid:${siteBPort}/sink` });
      res.end();
      return;
    }
    res.writeHead(302, { location: `http://b.example.invalid:${siteBPort}/ok` });
    res.end();
  });

  const wsLargeServer = http.createServer();
  const bigPayload = Buffer.alloc(70000, 0x42);
  wsLargeServer.on("upgrade", (req, socket) => {
    trackSocket(socket);
    if (req.url === "/hang") return;
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (req.url === "/idle") return;
    const part1 = bigPayload.subarray(0, 4000);
    const h1 = Buffer.alloc(4);
    h1[0] = 0x02;
    h1[1] = 126;
    h1.writeUInt16BE(part1.length, 2);

    const part2 = bigPayload.subarray(4000);
    const h2 = Buffer.alloc(10);
    h2[0] = 0x80;
    h2[1] = 127;
    h2.writeBigUInt64BE(BigInt(part2.length), 2);
    socket.write(Buffer.concat([h1, part1, h2, part2]));
  });

  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    trackSocket(clientSocket);
    if (String(req.url).startsWith("stall.example.invalid:")) {
      const markClosed = () => {
        pendingProxySocketDestroyed = true;
        clientSocket.destroy();
      };
      clientSocket.on("end", markClosed);
      clientSocket.on("close", markClosed);
      clientSocket.on("error", markClosed);
      return;
    }
    const [, portStr] = String(req.url).split(":");
    const upstream = net.connect(Number(portStr), "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    trackSocket(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise((r) => siteB.listen(0, "127.0.0.1", r));
  await new Promise((r) => siteA.listen(0, "127.0.0.1", r));
  await new Promise((r) => wsLargeServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r));
  siteBPort = siteB.address().port;
  const siteAPort = siteA.address().port;
  const wsPort = wsLargeServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

  let sameOriginLookupCalls = 0;
  const fakeRebindLookup = async (host) => {
    if (host === "a.example.invalid" || host === "b.example.invalid") {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    if (host === "same-origin.attacker.invalid") {
      sameOriginLookupCalls += 1;
      return sameOriginLookupCalls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    }
    if (host === "rebind.attacker.invalid") return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  };

  const certDir = mkdtempSync(join(tmpdir(), "beeftv-colab-tls-test-"));
  let selfSignedServer = null;

  try {
    for (const mode of ["localhost_dot", "v6_mapped_hex", "v6_mapped_dotted", "dns_rebind", "unresolvable_redirect"]) {
      await assert.rejects(
        defaultFetch(`http://a.example.invalid:${siteAPort}/?mode=${mode}`, {
          proxyUrl,
          lookup: fakeRebindLookup,
        }),
        /内网或本机回环/,
      );
    }

    await assert.rejects(
      defaultFetch(`http://same-origin.attacker.invalid:${siteAPort}/?mode=same_origin_rebind`, {
        proxyUrl,
        requirePublicTarget: true,
        lookup: fakeRebindLookup,
      }),
      /内网或本机回环/,
    );
    assert.equal(sameOriginLookupCalls, 2);

    await assert.rejects(
      defaultFetch(`http://127.0.0.1:${siteAPort}/?mode=dns_rebind`, {
        proxyUrl: "",
        lookup: fakeRebindLookup,
      }),
      /内网或本机回环/,
    );

    await assert.rejects(
      readReferenceImages([{ url: "http://169.254.169.254/latest/meta-data/" }], {
        fetchImpl: (u, init) => defaultFetch(u, { ...init, proxyUrl, lookup: fakeRebindLookup }),
      }),
      /内网或本机回环/,
    );
    await assert.rejects(
      readReferenceImages([{ url: `http://127.0.0.1:${siteAPort}/?mode=302ok` }], {
        fetchImpl: defaultFetch,
      }),
      /重定向/,
    );

    await assert.rejects(
      defaultFetch(`http://a.example.invalid:${siteAPort}/?mode=307body`, {
        method: "POST",
        body: "client_secret=super_secret",
        proxyUrl,
        lookup: fakeRebindLookup,
      }),
      /请求体/,
    );
    await assert.rejects(
      defaultFetch(`http://a.example.invalid:${siteAPort}/?mode=301put`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "super-secret-put-chunk",
        proxyUrl,
        lookup: fakeRebindLookup,
      }),
      /请求体/,
    );

    const safeCross = await defaultFetch(`http://a.example.invalid:${siteAPort}/?mode=302ok`, {
      method: "POST",
      body: "post-payload-not-forwarded",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer ya29.secret",
        "x-colab-runtime-proxy-token": "rt_secret",
        "x-goog-colab-token": "xsrf_secret",
        "x-public-trace": "keep-me",
      },
      proxyUrl,
      lookup: fakeRebindLookup,
    });
    assert.equal(safeCross.status, 200);
    assert.equal(targetMethod, "GET");
    assert.equal(targetBody, "");
    assert.equal(targetHeaders["content-type"], undefined);
    assert.equal(targetHeaders.authorization, undefined);
    assert.equal(targetHeaders["x-colab-runtime-proxy-token"], undefined);
    assert.equal(targetHeaders["x-goog-colab-token"], undefined);
    assert.equal(targetHeaders["x-public-trace"], "keep-me");

    const directCrossLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await assert.rejects(
      defaultFetch(`http://127.0.0.1:${siteAPort}/?mode=301put`, {
        method: "PUT",
        body: "direct-secret-put",
        proxyUrl: "",
        lookup: directCrossLookup,
      }),
      /请求体/,
    );

    const keyFile = join(certDir, "key.pem");
    const certFile = join(certDir, "cert.pem");
    const genCert = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=tls.example.invalid",
    ]);
    assert.equal(genCert.status, 0);
    selfSignedServer = https.createServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) },
      (_req, res) => {
        res.writeHead(200);
        res.end("untrusted");
      },
    );
    await new Promise((r) => selfSignedServer.listen(0, "127.0.0.1", r));
    const tlsPort = selfSignedServer.address().port;
    await assert.rejects(
      defaultFetch(`https://tls.example.invalid:${tlsPort}/`, { proxyUrl }),
      /certificate|self[- ]signed|DEPTH_ZERO_SELF_SIGNED_CERT/i,
    );

    const stalledWs = DefaultWebSocket("ws://stall.example.invalid:443/ws", { proxyUrl });
    await new Promise((r) => setTimeout(r, 25));
    stalledWs.close();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(pendingProxySocketDestroyed, true);

    const postOpenAbort = new AbortController();
    await new Promise((resolve, reject) => {
      const ws = DefaultWebSocket(`ws://ws.example.invalid:${wsPort}/idle`, {
        proxyUrl,
        signal: postOpenAbort.signal,
      });
      let opened = false;
      ws.onopen = () => {
        opened = true;
        assert.equal(ws.readyState, 1);
        postOpenAbort.abort(new Error("user cancelled post-open"));
      };
      ws.onclose = () => {
        if (!opened) {
          reject(new Error("closed before open"));
          return;
        }
        assert.equal(ws.readyState, 3);
        resolve();
      };
    });

    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = DefaultWebSocket(`ws://ws.example.invalid:${wsPort}/hang`, {
          proxyUrl,
          handshakeTimeoutMs: 80,
        });
        ws.onopen = () => resolve("unexpected");
        ws.onerror = (e) => reject(new Error(e?.message || "timeout"));
      }),
      /超时/,
    );

    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = DefaultWebSocket(`ws://ws.example.invalid:${wsPort}/big`, {
          proxyUrl,
          maxPayloadBytes: 16384,
        });
        ws.onmessage = () => resolve("unexpected");
        ws.onerror = (e) => reject(new Error(e?.message || "oversized"));
      }),
      /安全上限/,
    );

    const receivedBytes = await new Promise((resolve, reject) => {
      const ws = DefaultWebSocket(`ws://ws.example.invalid:${wsPort}/big`, { proxyUrl });
      ws.onerror = (e) => reject(new Error(e?.message || "err"));
      ws.onmessage = (ev) => {
        ws.close();
        resolve(Buffer.from(ev.data));
      };
    });
    assert.equal(receivedBytes.length, 70000);
    assert.equal(receivedBytes.equals(bigPayload), true);
  } finally {
    for (const sock of openSockets) sock.destroy();
    selfSignedServer?.close();
    selfSignedServer?.closeAllConnections?.();
    rmSync(certDir, { recursive: true, force: true });
    siteA.close();
    siteA.closeAllConnections?.();
    siteB.close();
    siteB.closeAllConnections?.();
    wsLargeServer.close();
    wsLargeServer.closeAllConnections?.();
    proxyServer.close();
    proxyServer.closeAllConnections?.();
  }
});
