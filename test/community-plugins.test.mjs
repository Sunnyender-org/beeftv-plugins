import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseStrictPartnerBoundMs, validateCatalogRepository, validateStrictHTTPSUrl } from "../scripts/validate-registry.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginsRoot = resolve(repoRoot, "plugins");

function createStubReact(effectQueue = []) {
  return {
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(init) {
      return [typeof init === "function" ? init() : init, () => {}];
    },
    useEffect(fn) {
      effectQueue.push(fn);
    },
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

function findTextNodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(findTextNodes);
  if (typeof node === "object" && node.props) {
    return findTextNodes(node.props.children);
  }
  return [];
}

function findElements(node, predicate) {
  const matches = [];
  const visit = (cur) => {
    if (cur == null || typeof cur !== "object") return;
    if (Array.isArray(cur)) {
      cur.forEach(visit);
      return;
    }
    if (predicate(cur)) matches.push(cur);
    if (cur.props?.children) visit(cur.props.children);
  };
  visit(node);
  return matches;
}

const BANNED_WORDS = ["\u8fb9\u754c", "\u95ed\u73af", "\u843d\u76d8", "\u8bed\u4e49", "\u5bf9\u9f50", "\u6536\u53e3"];
const ALLOWED_BEEFTV_KEYS = new Set(["name", "client", "surfaces", "permissions", "configuration", "contributes"]);
const COMMUNITY_DIRS = [
  "beeftv-plugin-prompt-optimizer",
  "beeftv-plugin-eagle-asset-connector",
  "beeftv-plugin-ai-art-critique",
  "beeftv-plugin-media-conversion",
];
const OFFICIAL_IDS = [
  "beeftv-plugin-character-replacement",
  "beeftv-plugin-colab",
  "beeftv-plugin-comfyui",
  "beeftv-plugin-runninghub",
  "beeftv-plugin-sticky-note",
  "beeftv-plugin-ecommerce-hero",
];
const BUILTIN_IDS = [
  "beeftv-plugin-ll2",
  "beeftv-plugin-ysdui",
  "beeftv-plugin-infistar",
  "beeftv-plugin-market",
];

function walkFiles(dir, predicate) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

test("all plugins satisfy license, author, manifest keys, zero bare imports, and no banned wording", () => {
  const dirs = readdirSync(pluginsRoot).sort();
  assert.deepEqual(dirs, [...OFFICIAL_IDS, ...BUILTIN_IDS, ...COMMUNITY_DIRS].sort());

  for (const dir of dirs) {
    const root = join(pluginsRoot, dir);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const licenseText = readFileSync(join(root, "LICENSE"), "utf8");
    assert.equal(pkg.name, dir);
    assert.ok(pkg.version, `${dir} missing version`);
    assert.ok(pkg.beeftv && typeof pkg.beeftv === "object", `${dir} missing beeftv manifest`);
    assert.equal(pkg.beeftv.id, undefined, `${dir} must derive ID from package.json name, not beeftv.id`);
    for (const key of Object.keys(pkg.beeftv)) {
      assert.ok(ALLOWED_BEEFTV_KEYS.has(key), `${dir} has disallowed beeftv key: ${key}`);
    }

    if (COMMUNITY_DIRS.includes(dir)) {
      assert.equal(pkg.license, "MIT", `${dir} must stay MIT`);
      assert.equal(pkg.author, "开源社区", `${dir} author must be 开源社区`);
      assert.match(licenseText, /Copyright \(c\) 2026 ddcat and Open AI Canvas contributors/);
      assert.match(licenseText, /Permission is hereby granted, free of charge/);
    } else {
      assert.equal(pkg.license, "Apache-2.0", `${dir} must stay Apache-2.0`);
      assert.match(licenseText, /Apache License/);
    }

    const clientDir = join(root, "client");
    if (existsSync(clientDir)) {
      const jsFiles = walkFiles(clientDir, (f) => f.endsWith(".js") || f.endsWith(".mjs"));
      for (const file of jsFiles) {
        const content = readFileSync(file, "utf8");
        const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g;
        let match;
        while ((match = importRe.exec(content)) !== null) {
          assert.ok(
            match[1].startsWith("./") || match[1].startsWith("../"),
            `${file} has bare module import "${match[1]}"`,
          );
        }
      }
    }

    const textFiles = walkFiles(root, (f) => /\.(?:js|mjs|ts|md|json)$/i.test(f));
    for (const file of textFiles) {
      const content = readFileSync(file, "utf8");
      if (COMMUNITY_DIRS.includes(dir)) {
        assert.equal(
          /ui\s*\?\.\s*notify\s*\?\.\s*\(\s*["'](?:error|success|warning|info)["']/.test(content),
          false,
          `${file} passes notify(level, msg) instead of notify(msg, level)`,
        );
      }
      for (const word of BANNED_WORDS) {
        assert.equal(content.includes(word), false, `${file} contains banned word "${word}"`);
      }
    }
  }
  for (const rel of ["README.md", "NOTICE"]) {
    const content = readFileSync(join(repoRoot, rel), "utf8");
    for (const word of BANNED_WORDS) {
      assert.equal(content.includes(word), false, `${rel} contains banned word "${word}"`);
    }
  }
});

test("prompt-optimizer plugin activates canvas.promptActions & app.settings and optimizes prompts", async () => {
  const pkg = JSON.parse(readFileSync(join(pluginsRoot, "beeftv-plugin-prompt-optimizer/package.json"), "utf8"));
  assert.deepEqual(pkg.beeftv.permissions, ["ai.text"]);
  const { activate, createPromptOptimizer, normalizeResult } = await import("../plugins/beeftv-plugin-prompt-optimizer/client/index.js");
  const slots = [];
  let payload;
  const dispose = activate({
    React: null,
    contribute: (slot, item) => {
      slots.push(slot);
      if (slot === "canvas.promptActions") payload = item;
      return () => {};
    },
  });
  assert.deepEqual(slots.sort(), ["app.settings", "canvas.promptActions"]);
  assert.equal(payload.id, "prompt-optimizer");
  assert.equal(typeof payload.optimizer.optimize, "function");

  const normalized = normalizeResult(
    {
      optimizedPrompt: "rain-soaked neon alley, 35mm, rim light",
      negativePrompt: "blurry",
      changes: ["补充镜头景别与光线"],
      assumptions: [],
      variants: [{ label: "电影感", prompt: "neon rain, anamorphic lens" }],
    },
    "neon alley",
  );
  assert.equal(normalized.variants.length, 1);

  const optimizer = createPromptOptimizer({
    ai: {
      text: {
        requestToolResponse: async () => ({
          content: "",
          toolCalls: [{ name: "optimize_prompt", arguments: JSON.stringify(normalized) }],
        }),
      },
    },
  });
  const optimized = await optimizer.optimize({
    generationMode: "image",
    mode: "model-adapt",
    targetModel: "flux-pro",
    targetProtocol: "black-forest-labs",
    prompt: "neon alley",
  });
  assert.equal(optimized.optimizedPrompt, "rain-soaked neon alley, 35mm, rim light");
  assert.ok(optimized.modelProfile);
  dispose();
});

test("eagle-asset-connector plugin activates slots, exposes source CRUD, and handles save/pagination", async () => {
  const { activate, createEagleAssetSource, eagleDownloadFileName, saveEagleOriginalItem } = await import(
    "../plugins/beeftv-plugin-eagle-asset-connector/client/index.js"
  );
  const calls = [];
  const slots = [];
  const savedDisk = [];
  const host = {
    React: null,
    config: { get: (_k, d) => d },
    ui: { notify: () => {} },
    contribute: (slot, payload) => {
      slots.push({ slot, payload });
      return () => {};
    },
    api: {
      baseURL: () => "/api",
      get: async (path, params) => {
        calls.push({ method: "GET", path, params });
        if (path.includes("library")) return { library: { folders: [{ id: "f1", name: "参考", parentId: "" }] } };
        return {
          items: [
            { id: "i1", name: "hero", size: 1024, extension: "png", tags: ["k"], folderIds: ["f1"], annotation: "note" },
          ],
        };
      },
      post: async (path, data) => {
        calls.push({ method: "POST", path, data });
        return { item: { id: "new-1" }, created: true };
      },
      getBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    },
    assets: {
      uploadImageBlob: async () => ({ url: "blob://img", storageKey: "k1", width: 100, height: 100, bytes: 3, mimeType: "image/png" }),
      uploadMediaFileBlob: async () => ({ url: "blob://media", storageKey: "m1", bytes: 3, mimeType: "video/mp4" }),
      imageToDataUrl: async () => "data:image/png;base64,AQID",
    },
    media: {
      getMediaBlob: async () => null,
      saveBlobToDisk: async (fileName, blob) => {
        savedDisk.push({ fileName, size: blob.size });
        return "saved";
      },
    },
  };
  const dispose = activate(host);
  assert.deepEqual(slots.map((s) => s.slot).sort(), ["app.page", "app.settings", "app.sidebar", "assets.source"]);
  assert.equal(eagleDownloadFileName({ title: "shot", metadata: { extension: "png" } }), "shot.png");
  assert.equal(eagleDownloadFileName({ title: "../../etc/passwd", metadata: { extension: "png" } }), "passwd.png");
  assert.equal(eagleDownloadFileName({ title: "a<b>c:d\\sub/file?.webp" }), "file_.webp");

  const src = createEagleAssetSource(host);
  const [concurrentFolders, concurrentItems] = await Promise.all([src.listFolders(), src.list({ limit: 200, offset: 0 })]);
  assert.equal(concurrentFolders.length, 1);
  assert.equal(concurrentItems.length, 1);
  assert.deepEqual(concurrentItems[0].folderPath, ["参考"]);
  assert.equal(
    calls.filter((c) => c.path === "/plugins/beeftv-plugin-eagle-asset-connector/library").length,
    1,
    "concurrent listFolders + list must share one in-flight /library request",
  );
  const imported = await src.importAsset(concurrentItems[0]);
  assert.equal(imported.data.storageKey, "k1");

  const saveOutcome = await saveEagleOriginalItem(host, "http://127.0.0.1:41595", concurrentItems[0]);
  assert.equal(saveOutcome, "saved");
  assert.deepEqual(savedDisk, [{ fileName: "hero.png", size: 3 }]);

  const originalWindow = globalThis.window;
  const desktopSaves = [];
  const notifications = [];
  try {
    globalThis.window = {
      go: {
        main: {
          DesktopApp: {
            SaveEagleMedia: async (fileName, url, itemId) => {
              desktopSaves.push({ fileName, url, itemId });
              return true;
            },
          },
        },
      },
    };
    const desktopOutcome = await saveEagleOriginalItem(
      { ...host, ui: { notify: (msg, level) => notifications.push({ msg, level }) } },
      "http://127.0.0.1:41595",
      { id: "i2", title: "../unsafe:shot", metadata: { extension: "png" } },
    );
    assert.equal(desktopOutcome, "saved");
    assert.deepEqual(desktopSaves, [{ fileName: "unsafe_shot.png", url: "http://127.0.0.1:41595", itemId: "i2" }]);
    assert.deepEqual(notifications, [{ msg: "已保存", level: "success" }]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }

  calls.length = 0;
  const sourceSlot = slots.find((s) => s.slot === "assets.source");
  assert.ok(sourceSlot);
  const folders = await sourceSlot.payload.provider.listFolders();
  assert.equal(folders.length, 1);
  const cachedItems = await sourceSlot.payload.provider.list({});
  assert.equal(cachedItems.length, 1);
  assert.equal(
    calls.filter((c) => c.path === "/plugins/beeftv-plugin-eagle-asset-connector/library").length,
    1,
    "registered assets.source should reuse cached Eagle folder index across calls",
  );
  dispose();

  const { createEagleLibraryPage } = await import("../plugins/beeftv-plugin-eagle-asset-connector/client/library-page.js");
  const states = [];
  const refs = [];
  let cursor = 0;
  let refCursor = 0;
  const statefulReact = {
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(init) {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = typeof init === "function" ? init() : init;
      const set = (v) => {
        states[idx] = typeof v === "function" ? v(states[idx]) : v;
      };
      return [states[idx], set];
    },
    useRef(init) {
      const idx = refCursor++;
      if (!(idx in refs)) refs[idx] = { current: init };
      return refs[idx];
    },
    useMemo(fn) {
      return fn();
    },
    useEffect() {},
  };
  let offsetSeen = null;
  let releaseFirstLoad;
  let loadCalls = 0;
  const pageHost = {
    React: statefulReact,
    config: { get: (_k, d) => d },
    ui: { notify: () => {} },
    api: {
      baseURL: () => "/api",
      get: async (path, params) => {
        if (path.includes("library")) return { library: { folders: [] } };
        offsetSeen = params?.offset ?? 0;
        loadCalls += 1;
        if (loadCalls === 1 && (params?.offset ?? 0) === 0) {
          return {
            items: Array.from({ length: 200 }, (_, n) => ({
              id: `id-${n}`,
              name: `item-${n}`,
              extension: "png",
              folderIds: [],
              tags: [],
            })),
          };
        }
        if (params?.offset === 200) {
          return { items: [{ id: "id-199", name: "dup" }, { id: "id-200", name: "page2", extension: "png", folderIds: [], tags: [] }] };
        }
        if (loadCalls === 2) {
          await new Promise((r) => { releaseFirstLoad = r; });
          return { items: [{ id: "stale", name: "stale-item", extension: "png", folderIds: [], tags: [] }] };
        }
        return { items: [{ id: "fresh", name: "fresh-item", extension: "png", folderIds: [], tags: [] }] };
      },
    },
  };
  const Page = createEagleLibraryPage(pageHost);
  const renderPage = () => {
    cursor = 0;
    refCursor = 0;
    return Page({});
  };
  let tree = renderPage();
  const findRefreshBtn = (t) => findElements(t, (el) => el.type === "button" && findTextNodes(el).includes("刷新")).pop();
  const flush = () => new Promise((r) => setTimeout(r, 10));
  const refreshBtn = findRefreshBtn(tree);
  assert.ok(refreshBtn, "expected 刷新 button in EagleLibraryPage");
  refreshBtn.props.onClick();
  await flush();
  tree = renderPage();
  const loadMoreBtn = findElements(tree, (el) => el.type === "button" && findTextNodes(el).some((t) => t.includes("加载更多")))[0];
  assert.ok(loadMoreBtn, "expected 加载更多 button when first batch has 200 items");
  loadMoreBtn.props.onClick();
  await flush();
  assert.equal(offsetSeen, 200);
  tree = renderPage();
  assert.match(findTextNodes(tree).join("\n"), /全部素材 \(201\)/);

  findRefreshBtn(tree).props.onClick();
  findRefreshBtn(tree).props.onClick();
  await flush();
  if (releaseFirstLoad) releaseFirstLoad();
  await flush();
  tree = renderPage();
  const finalText = findTextNodes(tree).join("\n");
  assert.match(finalText, /fresh-item/);
  assert.equal(finalText.includes("stale-item"), false, "stale response must not overwrite newer load");
});

test("ai-art-critique plugin runs multi-stage pipeline, resolves renderable previews, and detects disconnected stale state", async () => {
  const pkg = JSON.parse(readFileSync(join(pluginsRoot, "beeftv-plugin-ai-art-critique/package.json"), "utf8"));
  assert.ok(pkg.beeftv.permissions.includes("generation.run"));
  assert.equal(pkg.beeftv.contributes.canvasNodes[0].maxInputCount, 1);

  const mod = await import("../plugins/beeftv-plugin-ai-art-critique/client/index.js");
  const slots = [];
  const effects = [];
  const resolvedCalls = [];
  const React = createStubReact(effects);
  const dispose = mod.activate({
    React,
    events: { on: () => () => {} },
    ai: {},
    media: {
      renderableMediaUrl: (url) => (String(url).includes("/api/resources/") ? "" : String(url)),
      resolveImageUrl: async (storageKey, fallback, options) => {
        resolvedCalls.push({ storageKey, fallback, options });
        return "blob:critique-preview";
      },
    },
    contribute: (slot, payload) => {
      slots.push({ slot, payload });
      return () => {};
    },
  });
  assert.deepEqual(slots.map((s) => s.slot).sort(), ["canvas.addNodeMenu", "canvas.node"]);
  const nodeContribution = slots.find((s) => s.slot === "canvas.node").payload;
  assert.equal(nodeContribution.maxInputCount, 1);

  const createdNodes = [];
  slots.find((s) => s.slot === "canvas.addNodeMenu").payload.onSelect({
    handlers: { onAddExtensionNode: (t) => createdNodes.push(t) },
  });
  assert.deepEqual(createdNodes, ["ai-art-critique"]);

  const NodeCard = nodeContribution.component;
  const staleTree = NodeCard({
    node: {
      id: "critique-1",
      type: "ai-art-critique",
      metadata: {
        pluginData: {
          artCritique: {
            schemaVersion: 1,
            status: "completed",
            report: { summary: "ok", sourceFingerprint: "fp-old", issues: [], options: [] },
          },
        },
      },
    },
    upstreamNodes: [],
    updateMetadata: () => {},
  });
  const staleText = findTextNodes(staleTree).join(" ");
  assert.match(staleText, /待更新/);
  assert.match(staleText, /未连接输入图片/);

  const preferredPluginDataTree = NodeCard({
    node: {
      id: "critique-prefer-plugin-data",
      type: "ai-art-critique",
      metadata: {
        artCritique: { schemaVersion: 1, status: "failed", errorMessage: "legacy-error" },
        pluginData: {
          artCritique: {
            schemaVersion: 1,
            status: "completed",
            report: { summary: "ok", sourceFingerprint: "fp-current", issues: [{ id: "i0" }], options: [] },
          },
        },
      },
    },
    data: {
      artCritique: {
        schemaVersion: 1,
        status: "completed",
        report: { summary: "ok", sourceFingerprint: "fp-current", issues: [{ id: "i0" }], options: [] },
      },
    },
    upstreamNodes: [],
    updateMetadata: () => {},
  });
  const preferredText = findTextNodes(preferredPluginDataTree).join(" ");
  assert.match(preferredText, /待更新/);
  assert.equal(preferredText.includes("legacy-error"), false, "pluginData.artCritique must take precedence over legacy top-level metadata.artCritique");

  effects.length = 0;
  const withProtectedInput = NodeCard({
    node: { id: "critique-2", type: "ai-art-critique", metadata: {} },
    upstreamNodes: [
      { id: "img-1", type: "image", title: "分镜图", metadata: { storageKey: "resource:r1", content: "/api/resources/r1/file" } },
    ],
    updateMetadata: () => {},
  });
  const imgs = findElements(withProtectedInput, (el) => el.type === "img");
  assert.equal(imgs.length, 0, "protected /api/resources URL must not render directly in img src before blob resolution");
  for (const eff of effects) eff();
  assert.deepEqual(resolvedCalls[0], {
    storageKey: "resource:r1",
    fallback: "/api/resources/r1/file",
    options: { cacheMiss: true, renderable: true },
  });

  const repaired = mod.repairIssueTarget({
    id: "i1",
    category: "composition",
    title: "人物左侧构图偏空",
    explanation: "左侧前景留白过多",
    severity: "medium",
    confidence: 0.85,
    targetDescription: "左侧人物",
    target: { type: "box", points: [{ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.8 }] },
  });
  assert.equal(repaired.targetSource, "reference");
  assert.ok(mod.isRenderableArtCritiqueTarget(repaired.target));

  const stages = [];
  const report = await mod.runArtCritiquePipeline(
    null,
    { dataUrl: "data:image/png;base64,AA==", title: "portrait", sourceFingerprint: "fp1" },
    {
      model: "vision-model",
      onStage: (s) => stages.push(s),
      requestStage: async ({ toolName }) => {
        if (toolName === "analyze_art_scene") {
          return {
            toolCalls: [{
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  scene: {
                    imageType: "portrait",
                    style: ["photo"],
                    subjects: [{ id: "s1", description: "person", importance: "primary" }],
                    intendedFocus: "face",
                    compositionType: ["centered"],
                    lightingType: ["soft"],
                    mood: "calm",
                    estimatedIntent: "portrait",
                    sceneDepth: "shallow",
                  },
                }),
              },
            }],
          };
        }
        if (toolName === "review_art_lighting") {
          return {
            toolCalls: [{
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  candidates: [{
                    id: "c1",
                    checkId: "exposure",
                    kind: "issue",
                    category: "lighting",
                    title: "面部高光过曝",
                    observation: "额头高光溢出",
                    reason: "损失皮肤层次",
                    evidence: ["额头区域纯白无纹理"],
                    severity: 0.8,
                    confidence: 0.9,
                    targetDescription: "人物面部额头区域",
                  }],
                }),
              },
            }],
          };
        }
        if (toolName.startsWith("review_art_")) {
          return { toolCalls: [{ function: { name: toolName, arguments: JSON.stringify({ candidates: [] }) } }] };
        }
        if (toolName === "aggregate_art_critique") {
          return {
            toolCalls: [{
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  summary: "光线局部需要压低高光",
                  strengths: ["构图稳重"],
                  issues: [{
                    id: "issue-1",
                    category: "lighting",
                    title: "面部高光过曝",
                    explanation: "额头缺少细节",
                    severity: "high",
                    confidence: 0.9,
                    targetDescription: "人物面部",
                    sourceCandidateIds: ["c1"],
                    suggestion: { goal: "恢复面部高光细节", actions: ["降低高光曝光"], preserve: ["保留肤色"], expectedEffect: "纹理更自然" },
                  }],
                  options: [],
                }),
              },
            }],
          };
        }
        if (toolName === "ground_art_critique_issues") {
          return {
            toolCalls: [{
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  targets: [{ issueId: "issue-1", target: { type: "box", points: [{ x: 0.35, y: 0.15 }, { x: 0.65, y: 0.45 }] }, groundingConfidence: 0.92 }],
                }),
              },
            }],
          };
        }
        if (toolName === "verify_art_critique") {
          return { toolCalls: [{ function: { name: toolName, arguments: JSON.stringify({ decisions: [{ issueId: "issue-1", verdict: "confirmed", confidence: 0.9, reason: "visible" }] }) } }] };
        }
        return {
          toolCalls: [{
            function: {
              name: toolName,
              arguments: JSON.stringify({ prompts: [{ issueId: "issue-1", editPrompt: "压低额头高光并保留自然肤色" }] }),
            },
          }],
        };
      },
    },
  );
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].editPrompt, "压低额头高光并保留自然肤色");
  assert.ok(stages.includes("annotating"));
  dispose();
});

test("media-conversion plugin transforms pixels, resolves renderable URLs, and matches registry contract", async () => {
  const pkg = JSON.parse(readFileSync(join(pluginsRoot, "beeftv-plugin-media-conversion/package.json"), "utf8"));
  assert.equal(pkg.beeftv.contributes.canvasNodes[0].schema, undefined, "media-conversion writes top-level metadata.mediaConversion and must not advertise an unused pluginData schema");
  const mod = await import("../plugins/beeftv-plugin-media-conversion/client/index.js");
  const nodeSlots = [];
  const menuSlots = [];
  const effects = [];
  const resolveImageCalls = [];
  const resolveVideoCalls = [];
  const React = createStubReact(effects);
  const dispose = mod.activate({
    React,
    media: {
      getLocalRuntimeState: () => ({ connection: "connected", connecting: false }),
      renderableMediaUrl: (url) => (String(url).includes("/api/resources/") ? "" : String(url)),
      resolveImageUrl: async (storageKey, fallback, options) => {
        resolveImageCalls.push({ storageKey, fallback, options });
        return "blob:resolved-image";
      },
      resolveMediaUrl: async (storageKey, fallback, options) => {
        resolveVideoCalls.push({ storageKey, fallback, options });
        return "blob:resolved-video";
      },
    },
    contribute: (slot, payload) => {
      if (slot === "canvas.node") nodeSlots.push(payload);
      if (slot === "canvas.addNodeMenu") menuSlots.push(payload);
      return () => {};
    },
  });
  assert.equal(nodeSlots.length, 1);
  assert.equal(menuSlots.length, 1);
  const createdTypes = [];
  menuSlots[0].onSelect({ handlers: { onAddExtensionNode: (t) => createdTypes.push(t) } });
  assert.deepEqual(createdTypes, ["media-conversion"]);
  const NodeCard = nodeSlots[0].component;
  const rendered = NodeCard({
    node: { id: "mc-1", type: "media-conversion", metadata: { mediaConversion: { status: "completed", resultStorageKey: "resource:out-1" } } },
    upstreamNodes: [{ id: "vid-1", type: "video", metadata: { storageKey: "resource:vid-1", content: "/api/resources/vid-1/file" } }],
    updateMetadata: () => {},
  });
  assert.ok(rendered && rendered.type === "div");
  for (const eff of effects) eff();
  assert.deepEqual(resolveVideoCalls[0], {
    storageKey: "resource:vid-1",
    fallback: "/api/resources/vid-1/file",
    options: { renderable: true },
  });
  assert.deepEqual(resolveImageCalls[0], {
    storageKey: "resource:out-1",
    fallback: "",
    options: { cacheMiss: true, renderable: true },
  });

  const fpA = mod.mediaConversionSourceFingerprint({
    id: "n1",
    metadata: { storageKey: "resource:r1", content: "/api/resources/r1/file", mimeType: "image/png", bytes: 1024, naturalWidth: 800, naturalHeight: 600 },
  });
  const fpB = mod.mediaConversionSourceFingerprint({
    id: "n1",
    metadata: { storageKey: "resource:r1", content: "/api/resources/r1/file", mimeType: "image/png", bytes: 1024, naturalWidth: 800, naturalHeight: 600 },
  });
  assert.match(fpA, /^v1-[0-9a-f]{8}$/);
  assert.equal(fpA, fpB);

  assert.deepEqual(nodeSlots[0].acceptsInputKind, ["image", "video"]);
  assert.equal(
    nodeSlots[0].resourceKind({ metadata: { mediaConversion: { status: "completed", resultStorageKey: "img:1", outputKind: "image" } } }),
    "image",
  );
  assert.equal(
    nodeSlots[0].resourceKind({ metadata: { mediaConversion: { status: "processing" } } }),
    null,
  );

  const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const gray = mod.transformPixels(src, 2, 2, "grayscale");
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  assert.equal(gray[15], 255);

  const canny = mod.transformPixels(new Uint8ClampedArray(6 * 6 * 4).fill(255), 6, 6, "edge-canny");
  assert.equal(canny.length, 6 * 6 * 4);
  dispose();
});

test("infistar partner plugin exports valid preset, normalizes /v1 baseUrl, and activates settings panel", async () => {
  const pkg = JSON.parse(readFileSync(join(pluginsRoot, "beeftv-plugin-infistar/package.json"), "utf8"));
  const providerIds = (pkg.beeftv?.contributes?.providers || []).map((p) => p.id).sort();
  assert.deepEqual(providerIds, [
    "infistar-gemini-image",
    "infistar-image",
    "infistar-video",
    "infistar-video-json",
  ]);

  const mod = await import("../plugins/beeftv-plugin-infistar/client/index.js");
  assert.equal(mod.BUILTIN_SERVICE_PRESET.id, "infistar");
  assert.equal(mod.BUILTIN_SERVICE_PRESET.partner, true);
  assert.equal(mod.BUILTIN_SERVICE_PRESET.baseUrl, "https://infistar.cc");
  assert.equal(mod.BUILTIN_SERVICE_PRESET.keysUrl, "https://www.infistar.cc/register?aff=KBR9PG8Z&ref_source=link");
  assert.ok(mod.INFISTAR_PRESET_MODELS.length >= 30);

  const allowedProtocols = new Set(["chat-completion", ...providerIds]);
  for (const item of mod.INFISTAR_PRESET_MODELS) {
    assert.ok(allowedProtocols.has(item.protocol), `unexpected protocol ${item.protocol} on ${item.model}`);
  }

  const channel = mod.buildInfistarModelChannel({
    apiKey: "sk-test-placeholder",
    baseUrl: "https://infistar.ai/v1/",
  });
  assert.equal(channel.id, "infistar");
  assert.equal(channel.baseUrl, "https://infistar.ai");
  assert.equal(channel.models.length, mod.INFISTAR_PRESET_MODELS.length);
  assert.equal(channel.modelProfiles.length, mod.INFISTAR_PRESET_MODELS.length);

  const upgraded = mod.upgradeInfistarModelProfile({
    model: "MiniMax-H3",
    protocol: "infistar-video",
    capability: "video",
    capabilityConfig: { version: 1, video: { resolutions: ["720p"], defaultResolution: "720p" } },
  });
  assert.equal(upgraded.capabilityConfig.video.defaultResolution, "768p");

  const slots = [];
  const React = createStubReact();
  const dispose = mod.activate({
    React,
    config: { get: (_key, fallback = "") => fallback },
    channels: {
      list: () => [
        {
          id: "infistar",
          name: "无限星河 AI",
          baseUrl: "https://infistar.ai",
          hasApiKey: true,
          apiKey: "",
          models: ["MiniMax-H3"],
        },
      ],
    },
    contribute: (slot, payload) => {
      slots.push({ slot, payload });
      return () => {};
    },
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slot, "app.settings");
  const rendered = slots[0].payload.component({ config: {} });
  assert.ok(rendered && rendered.type === "div");
  const texts = findTextNodes(rendered).join(" ");
  assert.match(texts, /无限星河 AI/);
  const baseUrlInputs = findElements(rendered, (el) => el.props?.id === "infistar-plugin-base-url");
  assert.equal(baseUrlInputs.length, 1);
  assert.equal(baseUrlInputs[0].props.value, "https://infistar.ai");
  dispose();
});

test("registry.json entries match plugin manifests and dist tarballs without bare npm collisions", async () => {
  await validateCatalogRepository(repoRoot);
  assert.throws(() => validateStrictHTTPSUrl("http://hub.ll2.cn", "keysUrl"));
  assert.throws(() => validateStrictHTTPSUrl("https://user:pass@hub.ll2.cn", "keysUrl"));
  assert.throws(() => validateStrictHTTPSUrl("https://hub.ll2.cn#frag", "keysUrl"));
  assert.throws(() => parseStrictPartnerBoundMs("2026-02-30", false));
  assert.throws(() => parseStrictPartnerBoundMs("2026-11-03T00:00:00", false));
  assert.throws(() => parseStrictPartnerBoundMs("March 5, 2026", false));
  assert.ok(parseStrictPartnerBoundMs("2026-12-04", true) > parseStrictPartnerBoundMs("2026-12-04", false));

  const reg = JSON.parse(readFileSync(join(repoRoot, "registry.json"), "utf8"));
  assert.ok(Array.isArray(reg.plugins));
  assert.ok(Array.isArray(reg.builtins));
  const pkgNames = reg.plugins.map((p) => p.packageName).sort();
  assert.deepEqual(pkgNames, [...OFFICIAL_IDS, ...COMMUNITY_DIRS].sort());
  const builtinNames = reg.builtins.map((p) => p.packageName).sort();
  assert.deepEqual(builtinNames, [...BUILTIN_IDS].sort());

  const tmpPackDir = mkdtempSync(join(tmpdir(), "beeftv-plugins-pack-"));
  try {
    for (const entry of [...reg.plugins, ...reg.builtins]) {
      const pluginDir = join(pluginsRoot, entry.packageName);
      const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
      assert.equal(entry.id, pkg.name, `registry id mismatch for ${entry.packageName}`);
      assert.equal(entry.version, pkg.version, `registry version mismatch for ${entry.id}`);
      assert.equal(entry.packageName, pkg.name);
      if (COMMUNITY_DIRS.includes(entry.packageName)) {
        assert.equal(entry.npm, undefined, `${entry.packageName} must not advertise unowned bare npm name`);
      }
      const filename = entry.tarball.split("/").pop();
      const distPath = join(repoRoot, "dist", filename);
      assert.equal(existsSync(distPath), true, `missing packed tarball dist/${filename}`);
      const sha = createHash("sha256").update(readFileSync(distPath)).digest("hex");
      assert.equal(entry.sha256, sha, `registry sha256 mismatch for ${filename}`);

      const packedName = execFileSync("npm", ["pack", pluginDir, "--pack-destination", tmpPackDir], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .pop();
      assert.equal(packedName, filename);
      const freshPath = join(tmpPackDir, packedName);
      const listFiles = (archive) => execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/).sort();
      assert.deepEqual(listFiles(distPath), listFiles(freshPath), `dist/${filename} file list does not match fresh npm pack`);
      const extractFile = (archive, rel) => execFileSync("tar", ["-xOzf", archive, rel], { encoding: "utf8" });
      for (const rel of listFiles(freshPath)) {
        assert.equal(extractFile(distPath, rel), extractFile(freshPath, rel), `dist/${filename} file ${rel} is stale`);
      }
    }
  } finally {
    rmSync(tmpPackDir, { recursive: true, force: true });
  }
});
