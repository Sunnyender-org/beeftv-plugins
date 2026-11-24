import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as colabClientMod from "../plugins/beeftv-plugin-colab/client/index.js";
import {
  ColabAuthStore,
  buildGoogleAuthorizationUrl,
  extractAuthCodeFromInput,
  readJsonIfExists,
  resolvePluginStateDir,
  withLeaseProcessLock,
  writePrivateJson,
} from "../plugins/beeftv-plugin-colab/lib/colab-auth.mjs";
import { normalizeColabOrigin } from "../plugins/beeftv-plugin-colab/lib/colab-client.mjs";
import { ColabLocalControlServer } from "../plugins/beeftv-plugin-colab/lib/local-control-server.mjs";
import { ColabTaskStore, sanitizeRetainedRequest } from "../plugins/beeftv-plugin-colab/lib/task-store.mjs";
import {
  compileGenerationPlan,
  normalizeH3Prompt,
  resolveDimensions,
  validateGenerationRequest,
} from "../plugins/beeftv-plugin-colab/lib/workflows.mjs";
import { createColabProvider } from "../plugins/beeftv-plugin-colab/provider.mjs";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function createStubReact(initialStates = []) {
  let stateIdx = 0;
  return {
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(init) {
      const idx = stateIdx++;
      const val = idx < initialStates.length
        ? initialStates[idx]
        : typeof init === "function"
          ? init()
          : init;
      return [val, () => {}];
    },
    useEffect() {},
    useRef(init) {
      return { current: init };
    },
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
  };
}

function collectText(node) {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === "object" && node.props) {
    return collectText(node.props.children);
  }
  return [];
}

test("resolves persistent state dir inside installed dataDir/plugin-state and platform fallbacks", () => {
  assert.equal(
    resolvePluginStateDir(undefined, {
      moduleFilePath: "/data/plugins/beeftv-plugin-colab/package/lib/colab-auth.mjs",
      platform: "linux",
      homeDir: "/root",
      env: {},
    }),
    "/data/plugin-state/beeftv-plugin-colab",
  );

  assert.equal(
    resolvePluginStateDir(undefined, {
      moduleFilePath: "C:\\BeefTV\\data\\plugins\\beeftv-plugin-colab\\package\\lib\\colab-auth.mjs",
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
      env: {},
    }),
    "C:\\BeefTV\\data\\plugin-state\\beeftv-plugin-colab",
  );

  assert.equal(
    resolvePluginStateDir(undefined, {
      moduleFilePath: "C:\\repo\\plugin-packages\\beeftv-plugin-colab\\lib\\colab-auth.mjs",
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
      env: {},
    }),
    "C:\\Users\\Alice\\AppData\\Roaming\\beeftv-plugin-colab",
  );

  assert.equal(
    resolvePluginStateDir(undefined, {
      moduleFilePath: "/repo/plugin-packages/beeftv-plugin-colab/lib/colab-auth.mjs",
      platform: "darwin",
      homeDir: "/Users/creator",
      env: {},
    }),
    "/Users/creator/.config/beeftv-plugin-colab",
  );
});

test("builds remote OAuth URL, extracts code, enforces official origin allowlist, and blocks phishing origins", async () => {
  const url = new URL(buildGoogleAuthorizationUrl());
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://sdk.cloud.google.com/applicationdefaultauthcode.html");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("token_usage"), "remote");

  assert.equal(extractAuthCodeFromInput("  4/0AeanS0abcdefghijklmnopqrstuvwxyz  "), "4/0AeanS0abcdefghijklmnopqrstuvwxyz");
  assert.equal(
    extractAuthCodeFromInput("https://sdk.cloud.google.com/applicationdefaultauthcode.html?code=4%2F0AeanS0xyz1234567890&scope=openid"),
    "4/0AeanS0xyz1234567890",
  );

  assert.equal(normalizeColabOrigin(""), "https://colab.research.google.com");
  assert.equal(normalizeColabOrigin("https://colab.research.google.com/"), "https://colab.research.google.com");
  assert.throws(() => normalizeColabOrigin("https://colab.research.google.com:8443"));
  assert.throws(() => normalizeColabOrigin("https://evil.example"));
  assert.throws(() => normalizeColabOrigin("http://colab.research.google.com"));
  assert.throws(() => normalizeColabOrigin("http://127.0.0.1:9999"));
  assert.equal(normalizeColabOrigin("http://127.0.0.1:9999", { allowLoopbackOrigin: true }), "http://127.0.0.1:9999");

  const tempDir = mkdtempSync(join(tmpdir(), "beeftv-colab-origin-guard-"));
  const outboundUrls = [];
  const prodProvider = createColabProvider({
    stateDir: tempDir,
    colabCliTokenPath: join(tempDir, "none.json"),
    controlPorts: [0],
    fetchImpl: async (input) => {
      outboundUrls.push(String(input));
      return new Response("unexpected", { status: 500 });
    },
  });

  try {
    const rejected = await prodProvider.submit(
      { model: "minimax-h3-image-2k", prompt: "测试防钓鱼拦截" },
      {
        config: {
          baseUrl: "https://attacker.example",
          apiKey: "ya29.secret_token_should_never_leave_12345",
        },
      },
    );
    assert.equal(rejected.status, "failed");
    assert.equal(outboundUrls.length, 0);
  } finally {
    await prodProvider.manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exchanges OAuth code once, writes 0600 auth file, refreshes expired tokens, and falls back to colab-cli token", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "beeftv-colab-auth-"));
  const tokenCalls = [];

  const mockFetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      const params = Object.fromEntries(new URLSearchParams(String(init?.body || "")));
      tokenCalls.push(params);
      if (params.grant_type === "authorization_code") {
        if (params.code === "4/0A_first_valid_code_123456") {
          return Response.json({
            access_token: "ya29.access_first_account_token_12345",
            refresh_token: "1//0g_refresh_first_account_123456",
            expires_in: 10,
          });
        }
        if (params.code === "4/0A_second_panel_code_654321") {
          return Response.json({
            access_token: "ya29.access_second_account_token_65432",
            refresh_token: "1//0g_refresh_second_account_654321",
            expires_in: 3600,
          });
        }
        return Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 });
      }
      if (params.grant_type === "refresh_token") {
        return Response.json({
          access_token: "ya29.refreshed_access_token_999999",
          expires_in: 3600,
        });
      }
    }
    if (url.endsWith("/userinfo")) {
      const auth = new Headers(init?.headers).get("authorization") || "";
      const email = auth.includes("second") ? "second@example.com" : "creator@example.com";
      return Response.json({ email });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const store = new ColabAuthStore({
      stateDir: tempDir,
      colabCliTokenPath: join(tempDir, "nonexistent-cli-token.json"),
      oauth: {
        clientId: "cid",
        clientSecret: "csec",
        authUri: "https://mock.local/auth",
        tokenUri: "https://mock.local/token",
        redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
        userInfoUri: "https://mock.local/userinfo",
        scopes: ["openid"],
      },
      fetchImpl: mockFetch,
    });

    const firstToken = await store.resolveAccessToken({ apiKey: "4/0A_first_valid_code_123456" });
    assert.equal(firstToken, "ya29.access_first_account_token_12345");
    assert.equal(store.getPublicStatus().authorized, true);
    assert.equal(store.getPublicStatus().email, "creator@example.com");
    assert.equal(store.getPublicStatus().source, "plugin");

    if (process.platform !== "win32") {
      const mode = statSync(join(tempDir, "auth.json")).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const refreshedToken = await store.resolveAccessToken({ apiKey: "4/0A_first_valid_code_123456" });
    assert.equal(refreshedToken, "ya29.refreshed_access_token_999999");
    assert.deepEqual(tokenCalls.map((c) => c.grant_type), ["authorization_code", "refresh_token"]);

    await store.authorizeWithCode("4/0A_second_panel_code_654321");
    const activeAfterSwitch = await store.resolveAccessToken({ apiKey: "4/0A_first_valid_code_123456" });
    assert.equal(activeAfterSwitch, "ya29.access_second_account_token_65432");
    assert.equal(store.getPublicStatus().email, "second@example.com");

    const cliTokenFile = join(tempDir, "colab-cli-token.json");
    writeFileSync(
      cliTokenFile,
      JSON.stringify({
        token: "ya29.cli_cached_token_1234567890",
        refresh_token: "1//0g_cli_refresh_token_123456",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
        email: "cli-user@example.com",
      }),
    );
    const cliStore = new ColabAuthStore({
      stateDir: join(tempDir, "fresh-plugin-state"),
      colabCliTokenPath: cliTokenFile,
    });
    assert.equal(cliStore.getPublicStatus().authorized, true);
    assert.equal(cliStore.getPublicStatus().email, "cli-user@example.com");
    assert.equal(cliStore.getPublicStatus().source, "colab-cli");
    assert.equal(await cliStore.resolveAccessToken({ apiKey: "colab" }), "ya29.cli_cached_token_1234567890");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("compiles MiniMax-H3-Image and MOSS-Image workflows and guards task idempotency cleanly", async () => {
  assert.deepEqual(resolveDimensions({ family: "h3", tier: "4k", aspectRatio: "16:9", quality: "4k" }), {
    width: 5472,
    height: 3072,
  });
  assert.deepEqual(resolveDimensions({ family: "h3", tier: "2k", aspectRatio: "9:16", quality: "2k" }), {
    width: 1536,
    height: 2688,
  });
  const custom = resolveDimensions({ family: "h3", tier: "2k", aspectRatio: "1900x1070", quality: "2k" });
  assert.equal(custom.width % 32, 0);
  assert.equal(custom.height % 32, 0);

  const g4Plan = compileGenerationPlan(
    {
      model: "minimax-h3-image-4k",
      prompt: "把 @图片1 的背景换成黄昏海边，人物参考 @图片2",
      negativePrompt: "blurry, watermark",
      aspectRatio: "16:9",
      seed: 77,
      images: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
    },
    { accelerator: "G4", vramMib: 97887, refFilenames: ["ref1.png", "ref2.png"] },
  );
  assert.equal(g4Plan.profileKey, "h3_bf16");
  assert.equal(g4Plan.graph["1"].inputs.unet_name, "minimax_h3_image_pruned_bf16.safetensors");
  assert.equal(g4Plan.graph["4"].inputs.width, 5472);
  assert.equal(g4Plan.graph["4"].inputs.height, 3072);
  assert.deepEqual(g4Plan.graph["4"].inputs["images.image_1"], ["100", 0]);
  assert.deepEqual(g4Plan.graph["4"].inputs["images.image_2"], ["101", 0]);
  assert.equal(
    g4Plan.graph["4"].inputs.prompt,
    "把 <Picture 1> 的背景换成黄昏海边，人物参考 <Picture 2>\nAvoid: blurry, watermark",
  );

  const a100Plan = compileGenerationPlan(
    { model: "minimax-h3-image-2k", prompt: "赛博朋克雨夜霓虹招牌" },
    { accelerator: "A100", vramMib: 40536 },
  );
  assert.equal(a100Plan.profileKey, "h3_int8");
  assert.equal(
    normalizeH3Prompt("改成水彩插画风", "", 2),
    "Using <Picture 1>, <Picture 2> as visual reference: 改成水彩插画风",
  );

  const sanitizedEdit = sanitizeRetainedRequest({
    model: "moss-image-edit",
    prompt: "给人物戴上墨镜",
    aspectRatio: "auto",
    images: [{ dataUrl: "data:image/png;base64,AAAA", role: "reference" }],
  });
  assert.equal(JSON.stringify(sanitizedEdit).includes("AAAA"), false);

  const editPlan = compileGenerationPlan(sanitizedEdit, {
    accelerator: "A100",
    vramMib: 40536,
    refFilenames: ["a.png"],
  });
  assert.equal(editPlan.modelSpec.id, "moss-image-edit");
  assert.equal(editPlan.graph["2"].class_type, "LoraLoaderModelOnly");
  assert.equal(editPlan.graph["8"].inputs.edit_format, "Moss-Image-Edit");
  assert.deepEqual(editPlan.graph["8"].inputs["images.image_0"], ["101", 0]);

  const sanitizedSftWithRef = sanitizeRetainedRequest({
    model: "moss-image-sft",
    prompt: "改成胶片色调",
    images: [{ url: "https://example.com/a.png" }],
  });
  const upgradedPlan = compileGenerationPlan(sanitizedSftWithRef, {
    accelerator: "L4",
    vramMib: 23034,
    refFilenames: ["a.png"],
  });
  assert.equal(upgradedPlan.modelSpec.id, "moss-image-edit");
  assert.equal(upgradedPlan.outputNodeId, "12");

  assert.equal(validateGenerationRequest({ model: "unknown", prompt: "hi" }).ok, false);
  assert.equal(validateGenerationRequest({ model: "moss-image-edit", prompt: "改图", images: [] }).ok, false);

  const tempDir = mkdtempSync(join(tmpdir(), "beeftv-colab-idem-"));
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const store = new ColabTaskStore({ tasksDir: tempDir });
    await assert.rejects(
      store.runIdempotent("abort-key-1", async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("aborted");
      }),
      /aborted/,
    );
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(unhandled, false);
    assert.equal(store.idempotencyInFlight.size, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("local loopback control & media server enforces origins, PNA, and restart durability", async () => {
  const mediaDir = mkdtempSync(join(tmpdir(), "beeftv-colab-media-"));
  const firstServer = new ColabLocalControlServer({
    mediaDir,
    controlPorts: [0],
    handlers: {
      onGetStatus: async () => ({ okState: true }),
      onUpdateSettings: async () => ({}),
      onStop: async () => ({}),
    },
  });

  try {
    const url = await firstServer.registerOutputImage(PNG_BYTES, "poster.png");
    const port = firstServer.serverPort;

    const wailsPreflight = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://wails.localhost",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(wailsPreflight.status, 204);
    assert.equal(wailsPreflight.headers.get("access-control-allow-origin"), "http://wails.localhost");
    assert.equal(wailsPreflight.headers.get("access-control-allow-private-network"), "true");

    const wailsGet = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: "http://wails.localhost", "x-beeftv-colab": "1" },
    });
    assert.equal(wailsGet.status, 200);
    assert.equal((await wailsGet.json()).service, "beeftv-plugin-colab");

    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: "null", "x-beeftv-colab": "1" } })).status,
      403,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Origin: "file:///tmp/a.html", "x-beeftv-colab": "1" } })).status,
      403,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/auth`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-beeftv-colab": "1" },
          body: "{}",
        })
      ).status,
      404,
    );

    const pathname = new URL(url).pathname;
    const token = pathname.slice("/media/".length);
    await firstServer.close();

    const restartedServer = new ColabLocalControlServer({
      mediaDir,
      controlPorts: [0],
      handlers: {
        onGetStatus: async () => ({}),
        onUpdateSettings: async () => ({}),
        onStop: async () => ({}),
      },
    });
    const newPort = await restartedServer.ensureStarted();
    try {
      const diskRes = await fetch(`http://127.0.0.1:${newPort}${pathname}`);
      assert.equal(diskRes.status, 200);
      assert.deepEqual(Buffer.from(await diskRes.arrayBuffer()), PNG_BYTES);

      unlinkSync(join(mediaDir, token));
      const missingAfterUnlink = await fetch(`http://127.0.0.1:${newPort}${pathname}`);
      assert.equal(missingAfterUnlink.status, 404);
    } finally {
      await restartedServer.close();
    }
  } finally {
    await firstServer.close();
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("client UI registers settings/sidePanel slots and renders Google AI Pro onboarding, verified zero-session status, and immediate-stop option", () => {
  const registered = new Map();
  let disposedCount = 0;

  // 1) Loading state + slot registration/disposal
  const loadingHost = {
    React: createStubReact(),
    contribute(slot, entry) {
      registered.set(slot, entry);
      return () => {
        disposedCount += 1;
      };
    },
  };
  const dispose = colabClientMod.activate(loadingHost);
  assert.deepEqual([...registered.keys()].sort(), ["app.settings", "canvas.sidePanel"]);
  const loadingText = collectText(registered.get("app.settings").component()).join(" ");
  assert.match(loadingText, /正在读取 Colab 算力状态/);
  dispose();
  assert.equal(disposedCount, 2);

  // 2) Unauthorized state shows Google AI Pro / Ultra free quota and colab-cli reuse hint
  const unauthSlots = new Map();
  colabClientMod.activate({
    React: createStubReact([false, false, null, "", null]),
    contribute(slot, entry) {
      unauthSlots.set(slot, entry);
      return () => {};
    },
  });
  const unauthText = collectText(unauthSlots.get("app.settings").component()).join(" ");
  assert.match(unauthText, /Google AI Pro 每月送 200 CU/);
  assert.match(unauthText, /600 CU/);
  assert.match(unauthText, /Ultra 送 1000～2000 CU/);
  assert.match(unauthText, /google-colab-cli/);

  // 3) Authorized stopped state shows verified 0 active sessions, billing delay note, and 用完即停 option
  const stoppedStatus = {
    auth: { authorized: true, email: "pro@example.com", source: "plugin" },
    settings: { gpuPreference: "auto", idleStopMinutes: 0 },
    ccu: { balance: 598.0, hourlyRate: 0, assignmentsCount: 1 },
    sessions: { count: 0, verified: true, accelerators: [], checkedAt: "2026-11-25T00:00:00Z" },
    runtime: { active: false, accelerator: "", endpoint: "", stage: "stopped", stageDetail: "当前未开启云端显卡，不消耗计算单元" },
    activeTask: null,
    queuedCount: 0,
    idleRemainingSeconds: 0,
  };
  const authSlots = new Map();
  colabClientMod.activate({
    React: createStubReact([false, true, stoppedStatus, "", null]),
    contribute(slot, entry) {
      authSlots.set(slot, entry);
      return () => {};
    },
  });
  const authText = collectText(authSlots.get("app.settings").component()).join(" ");
  assert.match(authText, /已停机 · 0 个活跃会话/);
  assert.match(authText, /云端活跃会话：0（已确认停计费）/);
  assert.match(authText, /数十分钟延迟/);
  assert.match(authText, /用完即停/);
  // Lagging ccu.assignmentsCount=1 MUST NOT trigger false warning when live sessions.count=0 is verified
  assert.doesNotMatch(authText, /释放账号下运行中的会话/);

  // 4) Other active Colab session shows honest warning & release-all action
  const otherSessionStatus = {
    ...stoppedStatus,
    sessions: { count: 1, verified: true, accelerators: ["L4"], checkedAt: "2026-11-25T00:00:00Z" },
  };
  const warnSlots = new Map();
  colabClientMod.activate({
    React: createStubReact([false, true, otherSessionStatus, "", null]),
    contribute(slot, entry) {
      warnSlots.set(slot, entry);
      return () => {};
    },
  });
  const warnText = collectText(warnSlots.get("canvas.sidePanel").component()).join(" ");
  assert.match(warnText, /账号下有 1 个活跃会话/);
  assert.match(warnText, /云端活跃会话：1 个（L4）/);
  assert.match(warnText, /释放账号下运行中的会话/);
});

test("in-flight OAuth refresh never overwrites a newly authorized account and stale lease.lock reclaim stays mutually exclusive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beeftv-colab-auth-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1) Slow refresh for Account A must not overwrite Account B saved concurrently
  let refreshEntered;
  let releaseRefresh;
  const entered = new Promise((r) => {
    refreshEntered = r;
  });
  const gate = new Promise((r) => {
    releaseRefresh = r;
  });
  const store = new ColabAuthStore({
    stateDir: dir,
    colabCliTokenPath: join(dir, "none.json"),
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/userinfo")) {
        return Response.json({ email: "account-b@example.com" });
      }
      const params = new URLSearchParams(String(init?.body || ""));
      if (params.get("grant_type") === "refresh_token") {
        refreshEntered();
        await gate;
        return Response.json({ access_token: "ya29.account_a_refreshed_123456", expires_in: 3600 });
      }
      return Response.json({
        access_token: "ya29.account_b_access_999999",
        refresh_token: "1//0g_account_b_refresh_999999",
        expires_in: 3600,
      });
    },
  });

  writePrivateJson(store.authFile, {
    accessToken: "ya29.account_a_expired_123456",
    refreshToken: "1//0g_account_a_refresh_123456",
    expiresAtMs: 0,
    email: "account-a@example.com",
    source: "plugin",
  });

  const pendingRefresh = store.resolveAccessToken();
  await entered;
  await store.authorizeWithCode("4/0A_account_b_auth_code_999999");
  releaseRefresh();
  await pendingRefresh;

  const savedAuth = readJsonIfExists(store.authFile);
  assert.equal(savedAuth.email, "account-b@example.com");
  assert.equal(savedAuth.refreshToken, "1//0g_account_b_refresh_999999");

  // 1b) Switching accounts via explicit refresh token (1//...) MUST persist Account B over Account A
  const switchStore = new ColabAuthStore({
    stateDir: join(dir, "switch-refresh"),
    colabCliTokenPath: join(dir, "none.json"),
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/userinfo")) {
        const auth = new Headers(init?.headers).get("authorization") || "";
        return Response.json({ email: auth.includes("acct_b") ? "account-b@example.com" : "account-a@example.com" });
      }
      const params = new URLSearchParams(String(init?.body || ""));
      if (params.get("refresh_token") === "1//0g_account_b_refresh_token_999") {
        return Response.json({ access_token: "ya29.acct_b_access_999999", expires_in: 3600 });
      }
      return Response.json({ access_token: "ya29.acct_a_access_123456", expires_in: 3600 });
    },
  });
  writePrivateJson(switchStore.authFile, {
    accessToken: "ya29.acct_a_old_123456",
    refreshToken: "1//0g_account_a_refresh_token_111",
    expiresAtMs: Date.now() + 3600_000,
    email: "account-a@example.com",
    source: "plugin",
  });
  await switchStore.authorizeWithCode("1//0g_account_b_refresh_token_999");
  const switchedDisk = readJsonIfExists(switchStore.authFile);
  assert.equal(switchedDisk.refreshToken, "1//0g_account_b_refresh_token_999");
  assert.equal(switchedDisk.email, "account-b@example.com");
  assert.equal(switchStore.getPublicStatus().email, "account-b@example.com");

  // 1c) Concurrent logout (clearStored) during in-flight refresh must not resurrect old credentials
  let logoutRefreshEntered;
  let releaseLogoutRefresh;
  const logoutEntered = new Promise((r) => {
    logoutRefreshEntered = r;
  });
  const logoutGate = new Promise((r) => {
    releaseLogoutRefresh = r;
  });
  const logoutStore = new ColabAuthStore({
    stateDir: join(dir, "logout-race"),
    colabCliTokenPath: join(dir, "none.json"),
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/userinfo")) {
        return Response.json({ email: "account-a@example.com" });
      }
      logoutRefreshEntered();
      await logoutGate;
      return Response.json({ access_token: "ya29.resurrected_token_123456", expires_in: 3600 });
    },
  });
  writePrivateJson(logoutStore.authFile, {
    accessToken: "ya29.expired_token_123456",
    refreshToken: "1//0g_logout_refresh_token_111",
    expiresAtMs: 0,
    email: "account-a@example.com",
    source: "plugin",
  });
  const pendingLogoutRefresh = logoutStore.resolveAccessToken();
  await logoutEntered;
  logoutStore.clearStored();
  releaseLogoutRefresh();
  await pendingLogoutRefresh;
  assert.equal(logoutStore.getPublicStatus().authorized, false);
  assert.equal(logoutStore.readStored(), null);
  assert.equal(readJsonIfExists(logoutStore.authFile)?.loggedOut, true);

  // 1d) Refresh token switch A -> B -> A must allow switching back to previously used Account A
  const roundtripStore = new ColabAuthStore({
    stateDir: join(dir, "refresh-roundtrip"),
    colabCliTokenPath: join(dir, "none.json"),
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/userinfo")) {
        const auth = new Headers(init?.headers).get("authorization") || "";
        return Response.json({ email: auth.includes("acct_b") ? "b@example.com" : "a@example.com" });
      }
      const params = new URLSearchParams(String(init?.body || ""));
      if (params.get("refresh_token") === "1//0g_roundtrip_refresh_b_999") {
        return Response.json({ access_token: "ya29.acct_b_rt_token_999", expires_in: 3600 });
      }
      return Response.json({ access_token: "ya29.acct_a_rt_token_111", expires_in: 3600 });
    },
  });
  assert.equal(
    await roundtripStore.resolveAccessToken({ apiKey: "1//0g_roundtrip_refresh_a_111" }),
    "ya29.acct_a_rt_token_111",
  );
  assert.equal(roundtripStore.getPublicStatus().email, "a@example.com");
  assert.equal(
    await roundtripStore.resolveAccessToken({ apiKey: "1//0g_roundtrip_refresh_b_999" }),
    "ya29.acct_b_rt_token_999",
  );
  assert.equal(roundtripStore.getPublicStatus().email, "b@example.com");
  assert.equal(
    await roundtripStore.resolveAccessToken({ apiKey: "1//0g_roundtrip_refresh_a_111" }),
    "ya29.acct_a_rt_token_111",
  );
  assert.equal(roundtripStore.getPublicStatus().email, "a@example.com");

  // 1e) colab-cli fallback logout during in-flight refresh disables CLI auto-reuse and blocks resurrection
  const cliLogoutDir = join(dir, "cli-logout-race");
  const cliTokenFile = join(dir, "cli-token-logout.json");
  writeFileSync(
    cliTokenFile,
    JSON.stringify({
      token: "ya29.cli_expired_123456",
      refresh_token: "1//0g_cli_logout_refresh_123",
      expiry: new Date(0).toISOString(),
      email: "cli-logout@example.com",
    }),
  );
  let cliRefreshEntered;
  let releaseCliRefresh;
  const cliEntered = new Promise((r) => {
    cliRefreshEntered = r;
  });
  const cliGate = new Promise((r) => {
    releaseCliRefresh = r;
  });
  const cliLogoutStore = new ColabAuthStore({
    stateDir: cliLogoutDir,
    colabCliTokenPath: cliTokenFile,
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async () => {
      cliRefreshEntered();
      await cliGate;
      return Response.json({ access_token: "ya29.cli_resurrected_999", expires_in: 3600 });
    },
  });
  const pendingCliRefresh = cliLogoutStore.resolveAccessToken();
  await cliEntered;
  cliLogoutStore.clearStored();
  releaseCliRefresh();
  await pendingCliRefresh;
  assert.equal(cliLogoutStore.getPublicStatus().authorized, false);
  assert.equal(cliLogoutStore.readStored(), null);
  assert.equal(readJsonIfExists(cliLogoutStore.authFile)?.loggedOut, true);
  assert.equal(readJsonIfExists(cliLogoutStore.authFile)?.disableCliFallback, true);

  // 1f) Cross-process auth.lock.d CAS: concurrent child process switching to Account B is never overwritten by parent refresh
  const mpAuthDir = join(dir, "mp-auth-cas");
  const authModuleUrl = new URL("../plugins/beeftv-plugin-colab/lib/colab-auth.mjs", import.meta.url).href;
  let mpRefreshEntered;
  let releaseMpRefresh;
  const mpEntered = new Promise((r) => {
    mpRefreshEntered = r;
  });
  const mpGate = new Promise((r) => {
    releaseMpRefresh = r;
  });
  const mpParentStore = new ColabAuthStore({
    stateDir: mpAuthDir,
    colabCliTokenPath: join(dir, "none.json"),
    oauth: {
      clientId: "cid",
      clientSecret: "csec",
      authUri: "https://mock.local/auth",
      tokenUri: "https://mock.local/token",
      redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
      userInfoUri: "https://mock.local/userinfo",
      scopes: ["openid"],
    },
    fetchImpl: async () => {
      mpRefreshEntered();
      await mpGate;
      return Response.json({ access_token: "ya29.mp_parent_a_refreshed_123", expires_in: 3600 });
    },
  });
  writePrivateJson(mpParentStore.authFile, {
    accessToken: "ya29.mp_parent_a_expired_123",
    refreshToken: "1//0g_mp_parent_a_refresh_123",
    expiresAtMs: 0,
    email: "mp-a@example.com",
    source: "plugin",
  });
  const mpPending = mpParentStore.resolveAccessToken();
  await mpEntered;
  const childAuthScript = `
    import { ColabAuthStore } from ${JSON.stringify(authModuleUrl)};
    const [stateDir] = process.argv.slice(1);
    const store = new ColabAuthStore({
      stateDir,
      colabCliTokenPath: stateDir + "/none.json",
      oauth: {
        clientId: "cid",
        clientSecret: "csec",
        authUri: "https://mock.local/auth",
        tokenUri: "https://mock.local/token",
        redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
        userInfoUri: "https://mock.local/userinfo",
        scopes: ["openid"],
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/userinfo")) return Response.json({ email: "mp-b@example.com" });
        return Response.json({
          access_token: "ya29.mp_child_b_access_999",
          refresh_token: "1//0g_mp_child_b_refresh_999",
          expires_in: 3600,
        });
      },
    });
    await store.authorizeWithCode("4/0A_mp_child_b_code_999999");
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childAuthScript, mpAuthDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child auth failed ${code}: ${stderr}`))));
  });
  releaseMpRefresh();
  await mpPending;
  assert.equal(mpParentStore.getPublicStatus().email, "mp-b@example.com");
  assert.equal(readJsonIfExists(mpParentStore.authFile)?.refreshToken, "1//0g_mp_child_b_refresh_999");

  // 2) Concurrent callers AND real OS child processes reclaiming a dead-PID lease.lock.d directory stay strictly mutually exclusive
  const lockDir = join(dir, "lock-test");
  const staleLockPath = join(lockDir, "lease.lock.d");
  mkdirSync(staleLockPath, { recursive: true });
  writeFileSync(
    join(staleLockPath, "owner-dead.json"),
    JSON.stringify({
      pid: 999999999,
      nonce: "dead-nonce",
      createdAtMs: Date.now() - 120_000,
    }),
  );

  let activeCount = 0;
  let maxConcurrent = 0;
  await Promise.all(
    ["A", "B", "C"].map((role) =>
      withLeaseProcessLock(lockDir, { role }, async () => {
        activeCount += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        await new Promise((r) => setTimeout(r, 25));
        activeCount -= 1;
      }),
    ),
  );
  assert.equal(maxConcurrent, 1);
  assert.equal(existsSync(staleLockPath), false);

  // 3) Multi-process stale reclaim stress check: 3 real node child processes race on dead-PID lease.lock.d
  const mpLockDir = join(dir, "mp-lock-test");
  const mpStaleLock = join(mpLockDir, "lease.lock.d");
  const traceFile = join(dir, "mp-trace.jsonl");
  mkdirSync(mpStaleLock, { recursive: true });
  writeFileSync(
    join(mpStaleLock, "owner-deadproc.json"),
    JSON.stringify({
      pid: 999999999,
      nonce: "deadproc",
      createdAtMs: Date.now() - 120_000,
    }),
  );
  const workerScript = `
    import { appendFileSync } from "node:fs";
    import { withLeaseProcessLock } from ${JSON.stringify(authModuleUrl)};
    const [lockDir, tracePath, workerId] = process.argv.slice(1);
    await withLeaseProcessLock(lockDir, { workerId }, async () => {
      const start = Number(process.hrtime.bigint());
      appendFileSync(tracePath, JSON.stringify({ workerId, event: "enter", ts: start }) + "\\n");
      await new Promise((r) => setTimeout(r, 40));
      const end = Number(process.hrtime.bigint());
      appendFileSync(tracePath, JSON.stringify({ workerId, event: "exit", ts: end }) + "\\n");
    }, { timeoutMs: 8000, pollMs: 5 });
  `;
  const children = ["P1", "P2", "P3"].map(
    (id) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", workerScript, mpLockDir, traceFile, id], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${id} exited ${code}: ${stderr}`));
        });
      }),
  );
  await Promise.all(children);
  const events = readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 6);
  let depth = 0;
  let maxDepth = 0;
  for (const ev of events) {
    depth += ev.event === "enter" ? 1 : -1;
    maxDepth = Math.max(maxDepth, depth);
  }
  assert.equal(maxDepth, 1);
  assert.equal(depth, 0);
  assert.equal(existsSync(mpStaleLock), false);

  // 4) Active live-PID directory lock must not be clobbered before timeout
  const liveDir = join(dir, "live-lock-test");
  const liveLockPath = join(liveDir, "lease.lock.d");
  mkdirSync(liveLockPath, { recursive: true });
  writeFileSync(
    join(liveLockPath, "owner-live.json"),
    JSON.stringify({
      pid: process.pid,
      nonce: "live-owner",
      createdAtMs: Date.now(),
    }),
  );
  await assert.rejects(
    withLeaseProcessLock(liveDir, { role: "blocked" }, async () => {}, { timeoutMs: 120, pollMs: 10 }),
    (err) => err?.code === "LEASE_LOCK_TIMEOUT",
  );
  assert.equal(existsSync(join(liveLockPath, "owner-live.json")), true);
});
