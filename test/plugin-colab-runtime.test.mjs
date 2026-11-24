import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRemoteWorkerPythonSource } from "../plugins/beeftv-plugin-colab/lib/remote-worker-py.mjs";
import { createColabProvider } from "../plugins/beeftv-plugin-colab/provider.mjs";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    const out = Buffer.alloc(2 + payload.length);
    out[0] = 0x81;
    out[1] = payload.length;
    payload.copy(out, 2);
    return out;
  }
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0x81;
  out[1] = 126;
  out.writeUInt16BE(payload.length, 2);
  payload.copy(out, 4);
  return out;
}

function decodeWsClientFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskBytes = masked ? 4 : 0;
    if (pos + maskBytes + len > buf.length) break;
    const mask = masked ? buf.subarray(pos, pos + 4) : null;
    pos += maskBytes;
    const payload = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    }
    offset = pos + len;
    if (opcode === 0x01) {
      messages.push(payload.toString("utf8"));
    }
  }
  return { messages, remaining: buf.subarray(offset) };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startMockColabServer() {
  const state = {
    remoteFiles: new Map(),
    submittedJobPayloads: [],
    unassignedEndpoints: [],
    assignAttempts: [],
    activeEndpoints: new Map(),
    failG4With412: true,
    returnIncompatibleL4OnceOnGetAssign: true,
    failUnassignWith500: false,
    failUnassignRemaining: 0,
    delayUnassignMs: 0,
    delayListAssignmentsMs: 0,
    forceEmptyAssignmentsOnce: false,
    laggingCcuAssignmentsCount: null,
    transient503RemainingOnJobPoll: 0,
    force401OnJobPoll: false,
    suppressAutoJobResult: false,
    simulateStaleHeartbeat: false,
    jobPollStateReads: 0,
    nextEndpointSeq: 1,
    extraExternalSessions: [],
  };

  let port = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/tun/m/ccu-info") {
      const ccuCount =
        state.laggingCcuAssignmentsCount !== null
          ? state.laggingCcuAssignmentsCount
          : state.activeEndpoints.size + state.extraExternalSessions.length;
      const body = JSON.stringify({
        currentBalance: 98.4,
        consumptionRateHourly: ccuCount > 0 ? 1.88 : 0,
        assignmentsCount: ccuCount,
        eligibleGpus: ["G4", "A100", "L4"],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`)]}'\n${body}`);
      return;
    }

    if (url.pathname === "/tun/m/assignments") {
      const shouldForceEmpty = state.forceEmptyAssignmentsOnce;
      if (state.forceEmptyAssignmentsOnce) {
        state.forceEmptyAssignmentsOnce = false;
      }
      if (state.delayListAssignmentsMs > 0) {
        await new Promise((r) => setTimeout(r, state.delayListAssignmentsMs));
      }
      const active = shouldForceEmpty
        ? []
        : [
            ...[...state.activeEndpoints.values()],
            ...state.extraExternalSessions,
          ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`)]}'\n${JSON.stringify({ assignments: active })}`);
      return;
    }

    if (url.pathname === "/tun/m/assign") {
      const acc = url.searchParams.get("accelerator") || "G4";
      if (req.method === "GET") {
        if (state.returnIncompatibleL4OnceOnGetAssign) {
          state.returnIncompatibleL4OnceOnGetAssign = false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            `)]}'\n${JSON.stringify({
              endpoint: "ep-leftover-l4",
              accelerator: "L4",
              runtimeProxyInfo: {
                url: `http://127.0.0.1:${port}/runtime`,
                token: "proxy-tok-l4",
                tokenExpiresInSeconds: 3600,
              },
            })}`,
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`)]}'\n${JSON.stringify({ token: `xsrf-${acc}` })}`);
        return;
      }
      state.assignAttempts.push(acc);
      if (acc === "G4" && state.failG4With412) {
        res.writeHead(412);
        res.end("Precondition Failed");
        return;
      }
      const ep = `ep-${acc.toLowerCase()}-${state.nextEndpointSeq++}`;
      const record = {
        endpoint: ep,
        accelerator: acc,
        runtimeProxyInfo: {
          url: `http://127.0.0.1:${port}/runtime`,
          token: `proxy-tok-${ep}`,
          tokenExpiresInSeconds: 3600,
        },
      };
      state.activeEndpoints.set(ep, record);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`)]}'\n${JSON.stringify(record)}`);
      return;
    }

    if (url.pathname.startsWith("/tun/m/unassign/")) {
      const ep = decodeURIComponent(url.pathname.slice("/tun/m/unassign/".length));
      if (state.delayUnassignMs > 0 && req.method === "POST") {
        await new Promise((r) => setTimeout(r, state.delayUnassignMs));
      }
      if (state.failUnassignWith500 || state.failUnassignRemaining > 0) {
        if (state.failUnassignRemaining > 0 && req.method === "GET") {
          state.failUnassignRemaining -= 1;
        }
        res.writeHead(500);
        res.end("Upstream Error");
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`)]}'\n${JSON.stringify({ token: "unassign-xsrf" })}`);
        return;
      }
      state.unassignedEndpoints.push(ep);
      state.activeEndpoints.delete(ep);
      state.extraExternalSessions = state.extraExternalSessions.filter((item) => item.endpoint !== ep);
      state.remoteFiles.clear();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`)]}'\n{}`);
      return;
    }

    if (url.pathname === "/runtime/api/kernels") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "kernel-mock-1", name: "python3" }));
      return;
    }

    if (url.pathname.startsWith("/runtime/api/contents/")) {
      const relPath =
        "/" +
        url.pathname
          .slice("/runtime/api/contents/".length)
          .split("/")
          .map(decodeURIComponent)
          .join("/");

      if (req.method === "PUT") {
        const rawBody = await readBody(req);
        const payload = JSON.parse(rawBody || "{}");
        const chunkBytes = Buffer.from(
          String(payload.content || ""),
          payload.format === "base64" ? "base64" : "utf8",
        );
        const prev = payload.chunk && payload.chunk > 1 ? state.remoteFiles.get(relPath) || Buffer.alloc(0) : Buffer.alloc(0);
        const merged = Buffer.concat([prev, chunkBytes]);
        state.remoteFiles.set(relPath, merged);

        if (relPath.endsWith(".req.json")) {
          const jobReq = JSON.parse(merged.toString("utf8"));
          state.submittedJobPayloads.push(jobReq);
          if (!state.suppressAutoJobResult) {
            const outName = `${jobReq.job_id}_1.png`;
            state.remoteFiles.set(`/content/beeftv_worker/outputs/${outName}`, PNG_BYTES);
            state.remoteFiles.set(
              `/content/beeftv_worker/jobs/${jobReq.job_id}.res.json`,
              Buffer.from(
                JSON.stringify({
                  job_id: jobReq.job_id,
                  status: "succeeded",
                  elapsed_seconds: 3.2,
                  outputs: [{ filename: outName, width: 2048, height: 2048, bytes: PNG_BYTES.length }],
                }),
              ),
            );
          }
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: payload.name, path: relPath.slice(1), type: "file" }));
        return;
      }

      if (req.method === "GET") {
        if (state.simulateStaleHeartbeat && relPath === "/content/beeftv_worker/state.json" && state.submittedJobPayloads.length > 0) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "file",
              format: "base64",
              content: Buffer.from(
                JSON.stringify({
                  pid: 4321,
                  heartbeat_unix: Date.now() / 1000 - 120,
                  gpu_name: "NVIDIA A100-SXM4-40GB",
                  vram_total_mib: 40536,
                  vram_used_mib: 40500,
                  stage: "generating",
                  stage_detail: "显存耗尽假死模拟",
                }),
              ).toString("base64"),
            }),
          );
          return;
        }
        if (relPath.endsWith(".res.json")) {
          state.jobPollStateReads += 1;
          if (state.force401OnJobPoll) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          if (state.transient503RemainingOnJobPoll > 0) {
            state.transient503RemainingOnJobPoll -= 1;
            res.writeHead(503);
            res.end("Proxy NIC Busy");
            return;
          }
        }
        const found = state.remoteFiles.get(relPath);
        if (!found) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "file", format: "base64", content: found.toString("base64") }));
        return;
      }

      if (req.method === "DELETE") {
        state.remoteFiles.delete(relPath);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    res.writeHead(500);
    res.end(`unexpected route: ${url.pathname}`);
  });

  const upgradedSockets = new Set();
  server.on("upgrade", (req, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    const key = String(req.headers["sec-websocket-key"] || "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remaining } = decodeWsClientFrames(buffer);
      buffer = remaining;
      for (const raw of messages) {
        const msg = JSON.parse(raw);
        if (msg?.header?.msg_type === "execute_request") {
          state.remoteFiles.set(
            "/content/beeftv_worker/state.json",
            Buffer.from(
              JSON.stringify({
                pid: 4321,
                heartbeat_unix: Date.now() / 1000,
                gpu_name: "NVIDIA A100-SXM4-40GB",
                vram_total_mib: 40536,
                vram_used_mib: 512,
                disk_free_gb: 180.5,
                stage: "idle",
                stage_detail: "云端显卡已就绪，等待生成指令",
              }),
            ),
          );
          const parent = msg.header;
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({
                header: { msg_id: "s1", msg_type: "stream" },
                parent_header: parent,
                content: { name: "stdout", text: '{"ok":true,"pid":4321}\n' },
              }),
            ),
          );
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({
                header: { msg_id: "r1", msg_type: "execute_reply" },
                parent_header: parent,
                content: { status: "ok", execution_count: 1 },
              }),
            ),
          );
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({
                header: { msg_id: "st1", msg_type: "status" },
                parent_header: parent,
                content: { execution_state: "idle" },
              }),
            ),
          );
        }
      }
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  return {
    port,
    state,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        for (const sock of upgradedSockets) sock.destroy();
        upgradedSockets.clear();
        server.closeAllConnections?.();
      }),
  };
}

async function waitTaskTerminal(provider, taskId, model, ctx) {
  let q = await provider.query(taskId, { model }, ctx);
  const deadline = Date.now() + 5000;
  while (q.status !== "succeeded" && q.status !== "failed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 35));
    q = await provider.query(taskId, { model }, ctx);
  }
  return q;
}

test("executes H3/MOSS end-to-end, guards lease & verified sessions against concurrent polls, and handles stop errors", async (t) => {
  const mock = await startMockColabServer();
  const tempStateDir = mkdtempSync(join(tmpdir(), "beeftv-colab-e2e-"));
  const tasksDir = join(tempStateDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "colab_orphan_restart_1.json"),
    JSON.stringify({
      taskId: "colab_orphan_restart_1",
      status: "processing",
      stageDetail: "正在生成",
      message: "",
      result: null,
      createdAt: new Date().toISOString(),
    }),
  );

  const colabProvider = createColabProvider({
    stateDir: tempStateDir,
    colabCliTokenPath: join(tempStateDir, "none.json"),
    controlPorts: [0],
    pollIntervalMs: 35,
    workerReadyTimeoutMs: 3000,
    allowLoopbackOrigin: true,
  });

  t.after(async () => {
    await colabProvider.manager.close();
    await mock.close();
    rmSync(tempStateDir, { recursive: true, force: true });
  });

  const logs = [];
  const ctx = {
    config: {
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "ya29.mock_direct_access_token_1234567890",
    },
    signal: new AbortController().signal,
    log: (msg) => logs.push(msg),
  };

  const orphanStatus = await colabProvider.query("colab_orphan_restart_1", { model: "minimax-h3-image-2k" }, ctx);
  assert.equal(orphanStatus.status, "failed");

  const models = await colabProvider.models(ctx);
  assert.deepEqual(
    models.map((m) => m.id),
    ["minimax-h3-image-4k", "minimax-h3-image-2k", "moss-image-sft", "moss-image-edit"],
  );

  const controlPort = colabProvider.manager.serverPort;
  const refDataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

  // Stale status poll must not wipe new lease or overwrite new session count with stale 0
  colabProvider.manager.settings.managedEndpoint = "ep-stale-before-submit";
  mock.state.forceEmptyAssignmentsOnce = true;
  mock.state.delayListAssignmentsMs = 120;
  const slowStatusPromise = colabProvider.manager.getDashboardStatus({ forceRefresh: true });

  await new Promise((r) => setTimeout(r, 15));
  mock.state.delayListAssignmentsMs = 0;

  const h3Payload = {
    model: "minimax-h3-image-2k",
    prompt: "参考 @图片1 画一座海上灯塔",
    images: [{ dataUrl: refDataUrl, mimeType: "image/png" }],
    extra: { idempotencyKey: "idem-lighthouse-1" },
  };
  const [submittedH3, concurrentDup] = await Promise.all([
    colabProvider.submit(h3Payload, ctx),
    colabProvider.submit(h3Payload, ctx),
  ]);
  assert.equal(submittedH3.taskId, concurrentDup.taskId);

  const [h3Final] = await Promise.all([
    waitTaskTerminal(colabProvider, submittedH3.taskId, "minimax-h3-image-2k", ctx),
    slowStatusPromise,
  ]);
  assert.equal(h3Final.status, "succeeded");
  assert.ok(mock.state.unassignedEndpoints.includes("ep-leftover-l4"));
  assert.deepEqual(mock.state.assignAttempts, ["G4", "A100"]);
  assert.equal(h3Final.result?.images?.[0]?.ephemeral, true);
  assert.equal(colabProvider.manager.settings.managedEndpoint, "ep-a100-1");
  assert.ok(colabProvider.manager.idleDeadlineMs > Date.now());
  // Stale empty poll must not have marked sessions as verified 0 while ep-a100-1 is active
  const statusWhileActive = await colabProvider.manager.getDashboardStatus({ forceRefresh: false });
  assert.ok(statusWhileActive.sessions.count >= 1);

  // MOSS-Image-Edit and MOSS-SFT auto-upgrade with reference image
  const submittedMossEdit = await colabProvider.submit(
    {
      model: "moss-image-edit",
      prompt: "给人物戴上复古圆框墨镜",
      images: [{ dataUrl: refDataUrl, mimeType: "image/png" }],
    },
    ctx,
  );
  const mossEditFinal = await waitTaskTerminal(colabProvider, submittedMossEdit.taskId, "moss-image-edit", ctx);
  assert.equal(mossEditFinal.status, "succeeded");
  const mossEditRemoteReq = mock.state.submittedJobPayloads.find((j) => j.job_id === submittedMossEdit.taskId);
  assert.equal(mossEditRemoteReq?.output_node_id, "12");
  assert.equal(mossEditRemoteReq?.workflow?.["2"]?.class_type, "LoraLoaderModelOnly");
  assert.deepEqual(mossEditRemoteReq?.workflow?.["8"]?.inputs?.["images.image_0"], ["101", 0]);

  const submittedMossAuto = await colabProvider.submit(
    {
      model: "moss-image-sft",
      prompt: "把背景改成秋日银杏林",
      images: [{ dataUrl: refDataUrl, mimeType: "image/png" }],
    },
    ctx,
  );
  const mossAutoFinal = await waitTaskTerminal(colabProvider, submittedMossAuto.taskId, "moss-image-sft", ctx);
  assert.equal(mossAutoFinal.status, "succeeded");
  const mossAutoRemoteReq = mock.state.submittedJobPayloads.find((j) => j.job_id === submittedMossAuto.taskId);
  assert.equal(mossAutoRemoteReq?.output_node_id, "12");

  // Stop failure returns 502 and preserves managedEndpoint
  mock.state.failUnassignWith500 = true;
  const failedStopRes = await fetch(`http://127.0.0.1:${controlPort}/api/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ releaseAll: false }),
  });
  assert.equal(failedStopRes.status, 502);
  assert.equal(colabProvider.manager.settings.managedEndpoint, "ep-a100-1");

  // Recovery stops cleanly and verifies 0 live sessions even if /tun/m/ccu-info lags with assignmentsCount=1
  mock.state.failUnassignWith500 = false;
  mock.state.laggingCcuAssignmentsCount = 1;
  const stopRes = await fetch(`http://127.0.0.1:${controlPort}/api/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ releaseAll: false }),
  });
  const stopJson = await stopRes.json();
  assert.equal(stopJson.ok, true);
  assert.equal(stopJson.data.runtime.active, false);
  assert.equal(stopJson.data.ccu.assignmentsCount, 1);
  assert.equal(stopJson.data.sessions.verified, true);
  assert.equal(stopJson.data.sessions.count, 0);
  assert.ok(mock.state.unassignedEndpoints.includes("ep-a100-1"));
});

test("supports immediate release (idleStopMinutes=0) across queued tasks, concurrent arrivals, idle switch, startup reclaim, and stop retry", async (t) => {
  const mock = await startMockColabServer();
  mock.state.failG4With412 = false;
  mock.state.returnIncompatibleL4OnceOnGetAssign = false;

  const tempStateDir = mkdtempSync(join(tmpdir(), "beeftv-colab-imm-stop-"));
  const provider = createColabProvider({
    stateDir: tempStateDir,
    colabCliTokenPath: join(tempStateDir, "none.json"),
    controlPorts: [0],
    pollIntervalMs: 25,
    workerReadyTimeoutMs: 2000,
    immediateStopRetryMs: 80,
    allowLoopbackOrigin: true,
  });

  t.after(async () => {
    await provider.manager.close();
    await mock.close();
    rmSync(tempStateDir, { recursive: true, force: true });
  });

  const ctx = {
    config: {
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "ya29.immediate_stop_token_1234567890",
    },
    signal: new AbortController().signal,
  };

  await provider.models(ctx);
  const controlPort = provider.manager.serverPort;

  // Enable 用完即停 (idleStopMinutes = 0)
  const enableRes = await fetch(`http://127.0.0.1:${controlPort}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ idleStopMinutes: 0 }),
  });
  const enableJson = await enableRes.json();
  assert.equal(enableJson.ok, true);
  assert.equal(enableJson.data.settings.idleStopMinutes, 0);

  // 1) Two back-to-back queued tasks share one runtime, then immediately release once queue drains
  const [sub1, sub2] = await Promise.all([
    provider.submit({ model: "moss-image-sft", prompt: "雪山晨光" }, ctx),
    provider.submit({ model: "moss-image-sft", prompt: "湖面晚霞" }, ctx),
  ]);
  const [fin1, fin2] = await Promise.all([
    waitTaskTerminal(provider, sub1.taskId, "moss-image-sft", ctx),
    waitTaskTerminal(provider, sub2.taskId, "moss-image-sft", ctx),
  ]);
  assert.equal(fin1.status, "succeeded");
  assert.equal(fin2.status, "succeeded");

  const waitStopDeadline = Date.now() + 2000;
  while (provider.manager.settings.managedEndpoint !== "" && Date.now() < waitStopDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(provider.manager.settings.managedEndpoint, "");
  assert.equal(mock.state.assignAttempts.length, 1);
  assert.equal(mock.state.unassignedEndpoints.length, 1);
  const afterDrainStatus = await provider.manager.getDashboardStatus({ forceRefresh: false });
  assert.equal(afterDrainStatus.sessions.verified, true);
  assert.equal(afterDrainStatus.sessions.count, 0);

  // 2) New task arriving while immediate stop is in-flight waits cleanly and runs on a fresh runtime
  mock.state.delayUnassignMs = 120;
  const sub3 = await provider.submit({ model: "moss-image-sft", prompt: "海边灯塔" }, ctx);
  const fin3 = await waitTaskTerminal(provider, sub3.taskId, "moss-image-sft", ctx);
  assert.equal(fin3.status, "succeeded");
  // Submit task 4 immediately while task 3's stopRuntime is delayed
  const sub4 = await provider.submit({ model: "moss-image-sft", prompt: "森林木屋" }, ctx);
  const fin4 = await waitTaskTerminal(provider, sub4.taskId, "moss-image-sft", ctx);
  assert.equal(fin4.status, "succeeded");
  mock.state.delayUnassignMs = 0;

  const waitStop4 = Date.now() + 2500;
  while (provider.manager.settings.managedEndpoint !== "" && Date.now() < waitStop4) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(provider.manager.settings.managedEndpoint, "");
  assert.equal(mock.state.activeEndpoints.size, 0);

  // 3) Transient stop failure under idleStopMinutes=0 retries via immediateStopRetryMs instead of leaking GPU
  mock.state.failUnassignRemaining = 1;
  const sub5 = await provider.submit({ model: "moss-image-sft", prompt: "沙漠星空" }, ctx);
  const fin5 = await waitTaskTerminal(provider, sub5.taskId, "moss-image-sft", ctx);
  assert.equal(fin5.status, "succeeded");

  const retryDeadline = Date.now() + 2500;
  while (provider.manager.settings.managedEndpoint !== "" && Date.now() < retryDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(provider.manager.settings.managedEndpoint, "");
  assert.equal(mock.state.activeEndpoints.size, 0);

  // 4) Switching from 15min to 0min while idle immediately releases the lingering GPU
  await fetch(`http://127.0.0.1:${controlPort}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ idleStopMinutes: 15 }),
  });
  const sub6 = await provider.submit({ model: "moss-image-sft", prompt: "秋日古道" }, ctx);
  const fin6 = await waitTaskTerminal(provider, sub6.taskId, "moss-image-sft", ctx);
  assert.equal(fin6.status, "succeeded");
  assert.notEqual(provider.manager.settings.managedEndpoint, "");

  const switchToZeroRes = await fetch(`http://127.0.0.1:${controlPort}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ idleStopMinutes: 0 }),
  });
  const switchToZeroJson = await switchToZeroRes.json();
  assert.equal(switchToZeroJson.ok, true);
  assert.equal(switchToZeroJson.data.runtime.active, false);
  assert.equal(switchToZeroJson.data.sessions.verified, true);
  assert.equal(switchToZeroJson.data.sessions.count, 0);
  assert.equal(mock.state.activeEndpoints.size, 0);

  // 5) Startup reconciliation reclaims leftover managedEndpoint immediately when idleStopMinutes=0
  const reclaimDir = mkdtempSync(join(tmpdir(), "beeftv-colab-reclaim-zero-"));
  mock.state.activeEndpoints.set("ep-startup-zero-1", {
    endpoint: "ep-startup-zero-1",
    accelerator: "L4",
    runtimeProxyInfo: { url: `http://127.0.0.1:${mock.port}/runtime`, token: "tok", tokenExpiresInSeconds: 3600 },
  });
  writeFileSync(
    join(reclaimDir, "auth.json"),
    JSON.stringify({ accessToken: "ya29.reclaim_token_1234567890", expiresAtMs: Date.now() + 3600_000, source: "plugin" }),
  );
  writeFileSync(
    join(reclaimDir, "settings.json"),
    JSON.stringify({
      notebookHash: "22222222-3333-4444-5555-666666666666",
      gpuPreference: "auto",
      idleStopMinutes: 0,
      managedEndpoint: "ep-startup-zero-1",
      idleDeadlineMs: 0,
      leaseOwnerPid: 0,
      origin: `http://127.0.0.1:${mock.port}`,
    }),
  );
  const reclaimProvider = createColabProvider({
    stateDir: reclaimDir,
    colabCliTokenPath: join(reclaimDir, "none.json"),
    controlPorts: [0],
    allowLoopbackOrigin: true,
  });
  try {
    const reclaimDeadline = Date.now() + 2000;
    while (!mock.state.unassignedEndpoints.includes("ep-startup-zero-1") && Date.now() < reclaimDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(mock.state.unassignedEndpoints.includes("ep-startup-zero-1"));
  } finally {
    await reclaimProvider.manager.close();
    rmSync(reclaimDir, { recursive: true, force: true });
  }
});

test("detached lease-guardian releases GPU automatically when Node.js plugin-host exits abruptly", async (t) => {
  const mock = await startMockColabServer();
  const guardianDir = mkdtempSync(join(tmpdir(), "beeftv-colab-node-guardian-"));
  const managerModulePath = resolve(TEST_DIR, "../plugins/beeftv-plugin-colab/lib/session-manager.mjs");

  t.after(async () => {
    await mock.close();
    rmSync(guardianDir, { recursive: true, force: true });
  });

  writeFileSync(
    join(guardianDir, "auth.json"),
    JSON.stringify({
      accessToken: "ya29.guardian_cached_token_1234567890",
      expiresAtMs: Date.now() + 3600 * 1000,
      source: "plugin",
    }),
  );
  writeFileSync(
    join(guardianDir, "settings.json"),
    JSON.stringify({
      notebookHash: "11111111-2222-3333-4444-555555555555",
      gpuPreference: "auto",
      idleStopMinutes: 15,
      managedEndpoint: "ep-node-crash-99",
      idleDeadlineMs: Date.now() + 900 * 1000,
      leaseOwnerPid: 0,
      origin: `http://127.0.0.1:${mock.port}`,
    }),
  );

  const inlineScript = `
    import { ColabSessionManager } from ${JSON.stringify(managerModulePath)};
    new ColabSessionManager({
      stateDir: ${JSON.stringify(guardianDir)},
      colabCliTokenPath: ${JSON.stringify(join(guardianDir, "none.json"))},
      controlPorts: [0],
      allowLoopbackOrigin: true,
      installExitHooks: true,
      guardianGraceMs: 50,
    });
    setTimeout(() => process.exit(0), 40);
  `;

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", inlineScript], { stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`child exited with ${code}`));
    });
  });

  let afterSettings = JSON.parse(readFileSync(join(guardianDir, "settings.json"), "utf8"));
  const waitDeadline = Date.now() + 3500;
  while (
    (!mock.state.unassignedEndpoints.includes("ep-node-crash-99") || afterSettings.managedEndpoint !== "") &&
    Date.now() < waitDeadline
  ) {
    await new Promise((r) => setTimeout(r, 30));
    afterSettings = JSON.parse(readFileSync(join(guardianDir, "settings.json"), "utf8"));
  }

  assert.ok(mock.state.unassignedEndpoints.includes("ep-node-crash-99"));
  assert.equal(afterSettings.managedEndpoint, "");
});

test("retries transient 503 job polls, fails fast on 401 auth errors, and surfaces stale worker heartbeat", async (t) => {
  const mock = await startMockColabServer();
  mock.state.failG4With412 = false;
  mock.state.returnIncompatibleL4OnceOnGetAssign = false;

  const resilienceDir = mkdtempSync(join(tmpdir(), "beeftv-colab-poll-resilience-"));
  const resilienceProvider = createColabProvider({
    stateDir: resilienceDir,
    colabCliTokenPath: join(resilienceDir, "none.json"),
    controlPorts: [0],
    pollIntervalMs: 25,
    workerReadyTimeoutMs: 2000,
    heartbeatStaleWindowMs: 90,
    allowLoopbackOrigin: true,
  });

  t.after(async () => {
    await resilienceProvider.manager.close();
    await mock.close();
    rmSync(resilienceDir, { recursive: true, force: true });
  });

  const ctx = {
    config: {
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "ya29.mock_resilience_token_1234567890",
    },
    signal: new AbortController().signal,
  };

  // 1) Two transient 503 responses recover on 3rd attempt
  mock.state.jobPollStateReads = 0;
  mock.state.transient503RemainingOnJobPoll = 2;
  const t1 = await resilienceProvider.submit({ model: "moss-image-sft", prompt: "云海日出" }, ctx);
  const r1 = await waitTaskTerminal(resilienceProvider, t1.taskId, "moss-image-sft", ctx);
  assert.equal(r1.status, "succeeded");
  assert.equal(mock.state.jobPollStateReads, 3);

  // 2) 401 fails immediately on first poll
  mock.state.jobPollStateReads = 0;
  mock.state.force401OnJobPoll = true;
  const t2 = await resilienceProvider.submit({ model: "moss-image-sft", prompt: "雨夜霓虹" }, ctx);
  const r2 = await waitTaskTerminal(resilienceProvider, t2.taskId, "moss-image-sft", ctx);
  mock.state.force401OnJobPoll = false;
  assert.equal(r2.status, "failed");
  assert.equal(mock.state.jobPollStateReads, 1);

  // 3) Stale worker heartbeat fails cleanly
  mock.state.submittedJobPayloads.length = 0;
  mock.state.suppressAutoJobResult = true;
  mock.state.simulateStaleHeartbeat = true;
  const t3 = await resilienceProvider.submit({ model: "moss-image-sft", prompt: "深海鲸落" }, ctx);
  const r3 = await waitTaskTerminal(resilienceProvider, t3.taskId, "moss-image-sft", ctx);
  assert.equal(r3.status, "failed");
  assert.match(r3.message, /停止响应/);

  // 4) Persistent poll errors stop once heartbeatStaleWindowMs elapses instead of waiting 6 retries
  mock.state.submittedJobPayloads.length = 0;
  mock.state.suppressAutoJobResult = false;
  mock.state.simulateStaleHeartbeat = false;
  mock.state.jobPollStateReads = 0;
  mock.state.transient503RemainingOnJobPoll = 99;
  const t4 = await resilienceProvider.submit({ model: "moss-image-sft", prompt: "冰川极光" }, ctx);
  const r4 = await waitTaskTerminal(resilienceProvider, t4.taskId, "moss-image-sft", ctx);
  assert.equal(r4.status, "failed");
  assert.match(r4.message, /停止响应/);
  assert.ok(mock.state.jobPollStateReads < 6);
});

test("serializes in-flight settings stop with concurrent task allocation so new lease is preserved and later released", async (t) => {
  const mock = await startMockColabServer();
  mock.state.failG4With412 = false;
  mock.state.returnIncompatibleL4OnceOnGetAssign = false;

  const tempStateDir = mkdtempSync(join(tmpdir(), "beeftv-colab-lease-serial-"));
  const provider = createColabProvider({
    stateDir: tempStateDir,
    colabCliTokenPath: join(tempStateDir, "none.json"),
    controlPorts: [0],
    pollIntervalMs: 25,
    workerReadyTimeoutMs: 2000,
    allowLoopbackOrigin: true,
  });

  t.after(async () => {
    await provider.manager.close();
    await mock.close();
    rmSync(tempStateDir, { recursive: true, force: true });
  });

  const ctx = {
    config: {
      baseUrl: `http://127.0.0.1:${mock.port}`,
      apiKey: "ya29.lease_serial_token_1234567890",
    },
    signal: new AbortController().signal,
  };

  await provider.models(ctx);
  const controlPort = provider.manager.serverPort;

  // Task 1 allocates ep-g4-1 and remains idle under default 15min timeout
  const sub1 = await provider.submit({ model: "moss-image-sft", prompt: "第一张图" }, ctx);
  const fin1 = await waitTaskTerminal(provider, sub1.taskId, "moss-image-sft", ctx);
  assert.equal(fin1.status, "succeeded");
  assert.equal(provider.manager.settings.managedEndpoint, "ep-g4-1");

  // Delay unassign of ep-g4-1, trigger switch to idleStopMinutes=0, and concurrently submit Task 2
  mock.state.delayUnassignMs = 150;
  const switchPromise = fetch(`http://127.0.0.1:${controlPort}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
    body: JSON.stringify({ idleStopMinutes: 0 }),
  });

  await new Promise((r) => setTimeout(r, 25));
  mock.state.suppressAutoJobResult = true;
  const sub2 = await provider.submit({ model: "moss-image-sft", prompt: "并发第二张图" }, ctx);

  // Wait for switch-triggered stop of ep-g4-1 to finish
  const switchRes = await switchPromise;
  assert.equal(switchRes.status, 200);
  mock.state.delayUnassignMs = 0;

  // Task 2 must have serialized AFTER ep-g4-1 unassign, allocated ep-g4-2, and submitted its remote job cleanly
  const allocDeadline = Date.now() + 2500;
  while (
    (provider.manager.settings.managedEndpoint !== "ep-g4-2" ||
      !mock.state.submittedJobPayloads.some((j) => j.job_id === sub2.taskId)) &&
    Date.now() < allocDeadline
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(provider.manager.settings.managedEndpoint, "ep-g4-2");
  assert.ok(mock.state.unassignedEndpoints.includes("ep-g4-1"));
  assert.equal(mock.state.activeEndpoints.has("ep-g4-2"), true);

  // Now complete Task 2 and verify ep-g4-2 is cleanly released by idleStopMinutes=0
  const jobReq2 = mock.state.submittedJobPayloads.find((j) => j.job_id === sub2.taskId);
  assert.ok(jobReq2);
  const outName = `${sub2.taskId}_1.png`;
  mock.state.remoteFiles.set(`/content/beeftv_worker/outputs/${outName}`, PNG_BYTES);
  mock.state.remoteFiles.set(
    `/content/beeftv_worker/jobs/${sub2.taskId}.res.json`,
    Buffer.from(
      JSON.stringify({
        job_id: sub2.taskId,
        status: "succeeded",
        elapsed_seconds: 1.1,
        outputs: [{ filename: outName, width: 1024, height: 1024, bytes: PNG_BYTES.length }],
      }),
    ),
  );
  mock.state.suppressAutoJobResult = false;

  const fin2 = await waitTaskTerminal(provider, sub2.taskId, "moss-image-sft", ctx);
  assert.equal(fin2.status, "succeeded");

  const stopDeadline = Date.now() + 2000;
  while (provider.manager.settings.managedEndpoint !== "" && Date.now() < stopDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(provider.manager.settings.managedEndpoint, "");
  assert.ok(mock.state.unassignedEndpoints.includes("ep-g4-2"));
  assert.equal(mock.state.activeEndpoints.size, 0);
});

test("old lease-guardian aborts without unassigning or overwriting settings/auth when a new host takes over during OAuth refresh", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beeftv-colab-guardian-takeover-"));
  let tokenEnter;
  let releaseToken;
  const tokenEntered = new Promise((r) => {
    tokenEnter = r;
  });
  const tokenGate = new Promise((r) => {
    releaseToken = r;
  });
  let unassignCalled = false;

  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      tokenEnter();
      await tokenGate;
      res.end(JSON.stringify({ access_token: "ya29.old_account_refreshed_token_123456", expires_in: 3600 }));
      return;
    }
    if (req.url?.startsWith("/tun/m/unassign/")) {
      if (req.method === "POST") unassignCalled = true;
      res.end(JSON.stringify(req.method === "GET" ? { token: "xsrf" } : {}));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guardianScript = resolve(TEST_DIR, "../plugins/beeftv-plugin-colab/lib/lease-guardian.mjs");

  t.after(async () => {
    await new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    rmSync(dir, { recursive: true, force: true });
  });

  const settingsFile = join(dir, "settings.json");
  const authFile = join(dir, "auth.json");
  const initialSettings = {
    managedEndpoint: "ep-shared-1",
    leaseOwnerPid: 123,
    leaseToken: "lease-tok-old",
    origin,
    idleStopMinutes: 15,
    idleDeadlineMs: Date.now() + 600_000,
  };
  writeFileSync(settingsFile, JSON.stringify(initialSettings));
  writeFileSync(
    authFile,
    JSON.stringify({
      refreshToken: "1//0g_old_account_refresh_token_123456",
      expiresAtMs: 0,
      tokenUri: `${origin}/token`,
      email: "old-owner@example.com",
    }),
  );

  const child = spawn(
    process.execPath,
    [guardianScript, dir, "123", "20", "1", join(dir, "none.json"), "lease-tok-old"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  child.stdin.end();

  await tokenEntered;
  // New host process 456 takes over the endpoint AND switches auth.json to a brand-new Google account
  writeFileSync(
    settingsFile,
    JSON.stringify({
      ...initialSettings,
      leaseOwnerPid: 456,
      leaseToken: "lease-tok-new",
    }),
  );
  const newAuthRecord = {
    accessToken: "ya29.new_account_access_token_999999",
    refreshToken: "1//0g_new_account_refresh_token_999999",
    expiresAtMs: Date.now() + 3600_000,
    tokenUri: `${origin}/token`,
    email: "new-owner@example.com",
    source: "plugin",
  };
  writeFileSync(authFile, JSON.stringify(newAuthRecord));
  releaseToken();

  await new Promise((r) => child.once("exit", r));

  assert.equal(unassignCalled, false);
  const afterSettings = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(afterSettings.managedEndpoint, "ep-shared-1");
  assert.equal(afterSettings.leaseOwnerPid, 456);
  assert.equal(afterSettings.leaseToken, "lease-tok-new");

  const afterAuth = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(afterAuth.email, "new-owner@example.com");
  assert.equal(afterAuth.accessToken, "ya29.new_account_access_token_999999");
  assert.equal(afterAuth.refreshToken, "1//0g_new_account_refresh_token_999999");
});

test("new host startup reconciliation waits for old guardian in-flight unassign POST via lease.lock and allocates fresh runtime", async (t) => {
  const mock = await startMockColabServer();
  mock.state.failG4With412 = false;
  mock.state.returnIncompatibleL4OnceOnGetAssign = false;

  const dir = mkdtempSync(join(tmpdir(), "beeftv-colab-inflight-post-"));
  const guardianScript = resolve(TEST_DIR, "../plugins/beeftv-plugin-colab/lib/lease-guardian.mjs");

  // Wrap mock unassign POST with a deterministic gate by running a tiny proxy or delaying unassign
  let postEnteredResolve;
  let postReleaseResolve;
  const postEntered = new Promise((r) => {
    postEnteredResolve = r;
  });
  const postGate = new Promise((r) => {
    postReleaseResolve = r;
  });

  // Gate server in front of mock server specifically for POST /tun/m/unassign/ep-dying-1
  const gateServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/tun/m/unassign/ep-dying-1")) {
      postEnteredResolve();
      await postGate;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstreamRes = await fetch(`http://127.0.0.1:${mock.port}${req.url}`, {
      method: req.method,
      headers: {
        authorization: String(req.headers.authorization || ""),
        "content-type": String(req.headers["content-type"] || ""),
        "x-goog-colab-token": String(req.headers["x-goog-colab-token"] || ""),
        "x-colab-runtime-proxy-token": String(req.headers["x-colab-runtime-proxy-token"] || ""),
      },
      body,
    });
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") || "application/json" });
    res.end(text);
  });
  await new Promise((r) => gateServer.listen(0, "127.0.0.1", r));
  const gateOrigin = `http://127.0.0.1:${gateServer.address().port}`;

  mock.state.activeEndpoints.set("ep-dying-1", {
    endpoint: "ep-dying-1",
    accelerator: "G4",
    runtimeProxyInfo: { url: `http://127.0.0.1:${mock.port}/runtime`, token: "tok-dying", tokenExpiresInSeconds: 3600 },
  });

  const settingsFile = join(dir, "settings.json");
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      accessToken: "ya29.inflight_post_token_1234567890",
      expiresAtMs: Date.now() + 3600_000,
      source: "plugin",
    }),
  );
  writeFileSync(
    settingsFile,
    JSON.stringify({
      notebookHash: "33333333-4444-5555-6666-777777777777",
      gpuPreference: "auto",
      idleStopMinutes: 15,
      managedEndpoint: "ep-dying-1",
      idleDeadlineMs: Date.now() + 600_000,
      leaseOwnerPid: 777,
      leaseToken: "tok-old-777",
      origin: gateOrigin,
    }),
  );

  let newHost = null;
  t.after(async () => {
    if (newHost) await newHost.manager.close();
    await new Promise((r) => {
      gateServer.close(() => r());
      gateServer.closeAllConnections?.();
    });
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const oldGuardian = spawn(
    process.execPath,
    [guardianScript, dir, "777", "20", "1", join(dir, "none.json"), "tok-old-777"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  oldGuardian.stdin.end();

  // Wait until old guardian has acquired lease.lock and sent POST /tun/m/unassign/ep-dying-1
  await postEntered;

  // Start new host while old POST is still in-flight, and submit a generation task immediately
  newHost = createColabProvider({
    stateDir: dir,
    colabCliTokenPath: join(dir, "none.json"),
    controlPorts: [0],
    pollIntervalMs: 25,
    workerReadyTimeoutMs: 2000,
    allowLoopbackOrigin: true,
  });
  const ctx = {
    config: { baseUrl: gateOrigin, apiKey: "ya29.inflight_post_token_1234567890" },
    signal: new AbortController().signal,
  };
  const submitted = await newHost.submit({ model: "moss-image-sft", prompt: "互斥接管后的新图" }, ctx);

  // Give newHost 60ms to attempt startup reconcile while old POST is paused; it must wait on lease.lock
  await new Promise((r) => setTimeout(r, 60));
  const settingsWhilePaused = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(settingsWhilePaused.leaseOwnerPid, 777);
  assert.equal(mock.state.assignAttempts.length, 0);

  // Release old guardian's in-flight POST -> guardian clears settings.json and releases lease.lock
  postReleaseResolve();
  await new Promise((r) => oldGuardian.once("exit", r));

  // New host now reconciles (sees ep-dying-1 cleared), allocates fresh ep-g4-1, and finishes task cleanly
  const final = await waitTaskTerminal(newHost, submitted.taskId, "moss-image-sft", ctx);
  assert.equal(final.status, "succeeded");
  assert.ok(mock.state.unassignedEndpoints.includes("ep-dying-1"));
  assert.equal(newHost.manager.settings.managedEndpoint, "ep-g4-1");
  assert.notEqual(newHost.manager.settings.managedEndpoint, "ep-dying-1");
  assert.equal(mock.state.activeEndpoints.has("ep-g4-1"), true);
  assert.equal(mock.state.activeEndpoints.has("ep-dying-1"), false);
});

test("remote worker flush_state writes state.json atomically under _state_lock across concurrent threads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beeftv-colab-py-flush-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const workerFile = join(dir, "worker.py");
  const patchedSource = buildRemoteWorkerPythonSource().replaceAll("/content/beeftv_worker", dir);
  writeFileSync(workerFile, patchedSource, "utf8");

  const harness = `
import importlib.util, json, threading
from pathlib import Path

spec = importlib.util.spec_from_file_location("worker", ${JSON.stringify(workerFile)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

barrier = threading.Barrier(2)
errors = []

def run_writer(tag):
    try:
        for i in range(40):
            barrier.wait()
            mod.flush_state(stage=f"{tag}-{i}", stage_detail=f"round {i}")
    except Exception as exc:
        errors.append(repr(exc))

t1 = threading.Thread(target=run_writer, args=("hb",))
t2 = threading.Thread(target=run_writer, args=("main",))
t1.start()
t2.start()
t1.join()
t2.join()

assert not errors, f"concurrent flush_state errors: {errors}"
parsed = json.loads(Path(${JSON.stringify(join(dir, "state.json"))}).read_text())
assert "stage" in parsed and "heartbeat_unix" in parsed
`;

  const proc = spawn("python3", ["-c", harness], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.once("error", rejectPromise);
    proc.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`python3 flush_state test failed (${code}): ${stderr}`));
    });
  });
});

test("switching accounts preserves old managed lease against new account empty poll and releases old GPU with old credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beeftv-colab-acct-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const assignmentsByAccount = {
    A: new Map(),
    B: new Map(),
  };
  const unassignCalls = [];

  const mockFetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization") || "";

    // Mock Google OAuth token & userinfo endpoints
    if (url.includes("oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(String(init.body || ""));
      const code = params.get("code") || "";
      const refresh = params.get("refresh_token") || "";
      if (code === "4/0A_switch_acct_a_code_111" || refresh === "1//0g_switch_acct_a_refresh_111") {
        return Response.json({
          access_token: "ya29.switch_acct_a_token_111",
          refresh_token: "1//0g_switch_acct_a_refresh_111",
          expires_in: 3600,
        });
      }
      if (code === "4/0A_switch_acct_b_code_222" || refresh === "1//0g_switch_acct_b_refresh_222") {
        return Response.json({
          access_token: "ya29.switch_acct_b_token_222",
          refresh_token: "1//0g_switch_acct_b_refresh_222",
          expires_in: 3600,
        });
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
      return Response.json({
        email: auth.includes("acct_b") ? "acct-b@example.com" : "acct-a@example.com",
      });
    }

    const acct = auth.includes("acct_b") ? "B" : auth.includes("acct_a") ? "A" : "";
    if (!acct) return new Response("unauthorized", { status: 401 });
    const parsed = new URL(url);

    if (parsed.pathname === "/tun/m/ccu-info") {
      return new Response(`)]}'\n${JSON.stringify({ currentBalance: 200, consumptionRateHourly: 0, assignmentsCount: assignmentsByAccount[acct].size })}`, { status: 200 });
    }
    if (parsed.pathname === "/tun/m/assignments") {
      const list = [...assignmentsByAccount[acct].values()];
      return new Response(`)]}'\n${JSON.stringify({ assignments: list })}`, { status: 200 });
    }
    if (parsed.pathname.startsWith("/tun/m/unassign/")) {
      const ep = decodeURIComponent(parsed.pathname.slice("/tun/m/unassign/".length));
      if ((init.method || "GET") === "GET") {
        return new Response(`)]}'\n${JSON.stringify({ token: `unassign-tok-${ep}` })}`, { status: 200 });
      }
      unassignCalls.push({ acct, endpoint: ep });
      assignmentsByAccount[acct].delete(ep);
      return new Response(`)]}'\n${JSON.stringify({ ok: true })}`, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const provider = createColabProvider({
    stateDir: dir,
    colabCliTokenPath: join(dir, "none.json"),
    controlPorts: [0],
    fetchImpl: mockFetch,
    allowLoopbackOrigin: true,
    installExitHooks: false,
  });
  t.after(() => provider.manager.close());

  // 1) Authorize Account A and simulate an active managed lease owned by Account A
  await provider.manager.authStore.authorizeWithCode("4/0A_switch_acct_a_code_111");
  assignmentsByAccount.A.set("ep-acct-a", { endpoint: "ep-acct-a", accelerator: "L4" });
  provider.manager.settings.managedEndpoint = "ep-acct-a";
  provider.manager.settings.leaseAccountId = provider.manager.authStore.getCurrentAccountId();
  writeFileSync(join(dir, "settings.json"), JSON.stringify(provider.manager.settings, null, 2));

  // 2) Switch directly to Account B while Account A still owns ep-acct-a
  await provider.manager.authStore.authorizeWithCode("4/0A_switch_acct_b_code_222");
  assert.equal(provider.manager.authStore.getPublicStatus().email, "acct-b@example.com");

  // 3) Dashboard refresh polls Account B (0 assignments): MUST NOT clear Account A's ep-acct-a
  const statusAfterSwitch = await provider.manager.getDashboardStatus({ forceRefresh: true });
  assert.equal(statusAfterSwitch.sessions.count, 0);
  assert.equal(provider.manager.settings.managedEndpoint, "ep-acct-a");
  assert.equal(statusAfterSwitch.runtime.active, true);
  assert.equal(unassignCalls.length, 0);

  // 4) Stopping runtime MUST unassign ep-acct-a using Account A's token and prune previousAccounts
  await provider.manager.stopRuntime();
  assert.deepEqual(unassignCalls, [{ acct: "A", endpoint: "ep-acct-a" }]);
  assert.equal(assignmentsByAccount.A.size, 0);
  assert.equal(provider.manager.settings.managedEndpoint, "");
  assert.equal(provider.manager.settings.leaseAccountId, "");
  assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).previousAccounts, undefined);

  // 5) Now simulate Account B holding ep-acct-b, then switch back to Account A via listModels(apiKey=1//...):
  //    MUST proactively unassign ep-acct-b with Account B's token BEFORE replacing auth with Account A
  assignmentsByAccount.B.set("ep-acct-b", { endpoint: "ep-acct-b", accelerator: "G4" });
  provider.manager.settings.managedEndpoint = "ep-acct-b";
  provider.manager.settings.leaseAccountId = provider.manager.authStore.getCurrentAccountId();
  writeFileSync(join(dir, "settings.json"), JSON.stringify(provider.manager.settings, null, 2));

  await provider.models({
    config: {
      baseUrl: "http://127.0.0.1:18888",
      apiKey: "1//0g_switch_acct_a_refresh_111",
    },
  });
  assert.deepEqual(unassignCalls, [
    { acct: "A", endpoint: "ep-acct-a" },
    { acct: "B", endpoint: "ep-acct-b" },
  ]);
  assert.equal(assignmentsByAccount.B.size, 0);
  assert.equal(provider.manager.authStore.getPublicStatus().email, "acct-a@example.com");

  // 6) External colab-cli switch (A -> B in token.json) AFTER expired CLI A was auto-refreshed and allocated a GPU:
  //    CLI refresh writes only cliRefreshCache (not top-level plugin auth), so external CLI A -> B is immediately detected,
  //    old ep-cli-a is preserved across Account B's empty poll, and stopRuntime/ensureRuntime release ep-cli-a with A's refreshed token
  const cliDir = mkdtempSync(join(tmpdir(), "beeftv-colab-cli-switch-"));
  t.after(() => rmSync(cliDir, { recursive: true, force: true }));
  const cliTokenPath = join(cliDir, "cli-token.json");
  const cliRecord = (tag, { expired = false } = {}) => ({
    token: `ya29.cli_${tag}_${expired ? "expired" : "access"}_1234567890`,
    refresh_token: `1//0g_cli_${tag}_refresh_1234567890`,
    email: `cli-${tag}@example.com`,
    expiry: new Date(expired ? 0 : Date.now() + 3600 * 1000).toISOString(),
  });
  // Start with EXPIRED CLI Account A to force OAuth refresh before GPU allocation
  writeFileSync(cliTokenPath, JSON.stringify(cliRecord("a", { expired: true })));

  const cliMock = await startMockColabServer();
  cliMock.state.failG4With412 = false;
  cliMock.state.returnIncompatibleL4OnceOnGetAssign = false;
  t.after(() => cliMock.close());

  const cliUnassignAuthHeaders = [];
  const cliAssignAuthHeaders = [];
  const cliFetch = async (input, init = {}) => {
    const url = String(input);
    const authHeader = new Headers(init.headers).get("authorization") || "";
    if (url.includes("oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(String(init.body || ""));
      if (params.get("refresh_token") === "1//0g_cli_a_refresh_1234567890") {
        return Response.json({ access_token: "ya29.cli_a_refreshed_1234567890", expires_in: 3600 });
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.includes("/tun/m/assignments") && authHeader.includes("cli_b")) {
      return new Response(`)]}'\n${JSON.stringify({ assignments: [] })}`, { status: 200 });
    }
    if (url.includes("/tun/m/assign") && (init.method || "GET") === "POST") {
      cliAssignAuthHeaders.push(authHeader);
    }
    if (url.includes("/tun/m/unassign/") && (init.method || "GET") === "POST") {
      cliUnassignAuthHeaders.push(authHeader);
    }
    return fetch(input, init);
  };

  const cliProvider = createColabProvider({
    stateDir: cliDir,
    colabCliTokenPath: cliTokenPath,
    controlPorts: [0],
    pollIntervalMs: 15,
    workerReadyTimeoutMs: 5000,
    fetchImpl: cliFetch,
    allowLoopbackOrigin: true,
    installExitHooks: false,
  });
  t.after(() => cliProvider.manager.close());

  const cliCtx = { config: { baseUrl: `http://127.0.0.1:${cliMock.port}`, apiKey: "colab" } };
  const cliSubmitA = await cliProvider.submit({ model: "moss-image-sft", prompt: "CLI A 续期后分配" }, cliCtx);
  const cliFinalA = await waitTaskTerminal(cliProvider, cliSubmitA.taskId, "moss-image-sft", cliCtx);
  assert.equal(cliFinalA.status, "succeeded");
  const cliEndpointA = cliProvider.manager.settings.managedEndpoint;
  assert.ok(cliEndpointA);
  assert.ok(cliAssignAuthHeaders[0]?.includes("ya29.cli_a_refreshed_1234567890"));

  // Externally overwrite colab-cli/token.json with Account B (simulating `google-colab-cli login`)
  writeFileSync(cliTokenPath, JSON.stringify(cliRecord("b")));

  const cliStatusAfterExternalSwitch = await cliProvider.manager.getDashboardStatus({ forceRefresh: true });
  assert.equal(cliStatusAfterExternalSwitch.auth.email, "cli-b@example.com");
  assert.equal(cliStatusAfterExternalSwitch.auth.source, "colab-cli");
  assert.equal(cliStatusAfterExternalSwitch.sessions.count, 0);
  assert.equal(cliProvider.manager.settings.managedEndpoint, cliEndpointA);

  // Submitting a new task on CLI Account B MUST automatically release Account A's GPU with A's refreshed token first, then allocate under B
  const cliSubmitB = await cliProvider.submit({ model: "moss-image-sft", prompt: "CLI B 切号后自动释放 A 并新分配" }, cliCtx);
  const cliFinalB = await waitTaskTerminal(cliProvider, cliSubmitB.taskId, "moss-image-sft", cliCtx);
  assert.equal(cliFinalB.status, "succeeded");
  assert.equal(cliUnassignAuthHeaders.length, 1);
  assert.ok(cliUnassignAuthHeaders[0].includes("ya29.cli_a_refreshed_1234567890"));
  assert.notEqual(cliProvider.manager.settings.managedEndpoint, cliEndpointA);
  assert.ok(cliAssignAuthHeaders[1]?.includes("ya29.cli_b_access_1234567890"));
  assert.equal(cliProvider.manager.authStore.getPublicStatus().email, "cli-b@example.com");

  await cliProvider.manager.stopRuntime();
  assert.equal(cliProvider.manager.settings.managedEndpoint, "");
  assert.equal(cliProvider.manager.authStore.getPublicStatus().email, "cli-b@example.com");
});
