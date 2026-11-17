// 把一份 ComfyUI 工作流变成这一次生成要提交的图：找出提示词和素材该填到哪里、
// 换掉种子、记下要取哪些输出。节点分类表参考 Node Banana 的 src/lib/comfy/graph.ts（MIT）。

import { collectGraphComboOptions, convertEditorGraph, editorNodeTypes, extractAppMode, isEditorFormat } from "./editor.mjs";

// 读素材的节点，以及存文件名的控件和路径传递模式。
// annotated: ComfyUI /upload/image 返回相对于 input 目录的 `beeftv/...`；
// url: VHS_LoadVideoPath / VHS_LoadAudio 验证真实文件路径或 HTTP URL，传 `/api/view?...&type=input`。
const LOADERS = {
  LoadImage: { kind: "image", widget: "image", mode: "annotated" },
  LoadImageMask: { kind: "image", widget: "image", mode: "annotated" },
  LoadImageOutput: { kind: "image", widget: "image", mode: "annotated" },
  LoadVideo: { kind: "video", widget: "file", mode: "annotated" },
  VHS_LoadVideo: { kind: "video", widget: "video", mode: "annotated" },
  VHS_LoadVideoPath: { kind: "video", widget: "video", mode: "url" },
  LoadAudio: { kind: "audio", widget: "audio", mode: "annotated" },
  VHS_LoadAudio: { kind: "audio", widget: "audio_file", mode: "url" },
  VHS_LoadAudioUpload: { kind: "audio", widget: "audio", mode: "annotated" },
};

// 产出结果的节点。
const OUTPUTS = {
  SaveImage: "image",
  PreviewImage: "image",
  SaveAnimatedWEBP: "image",
  SaveAnimatedPNG: "image",
  Image_Save: "image",
  SaveVideo: "video",
  PreviewVideo: "video",
  SaveAnimatedMP4: "video",
  SaveWEBM: "video",
  VHS_VideoCombine: "video",
  SaveAudio: "audio",
  SaveAudioMP3: "audio",
  SaveAudioOpus: "audio",
  PreviewAudio: "audio",
};

const PROMPT_KEY = /(^|_)(prompt|text|caption|description|instruction)(_|$)/i;
const NON_USER_PROMPT_KEY = /(^|_)(negative|neg_prompt|system_prompt|sys_prompt|system_instruction|template|chat_template)(_|$)/i;
const POSITIVE_TITLE = /^(提示词|正向提示词|正向|用户提示词|prompt|positive(\s+prompt)?|user\s+prompt)$/i;
const NON_USER_TITLE = /(反向|负面|negative|system\s*prompt|系统提示词)/i;
const PROMPT_LINK_KEY = /^(positive|conditioning|guider|prompt|user_prompt|positive_prompt|raw_prompt|extra_prompt|text|text_g|text_l|t5xxl|clip_l|caption|description|instruction|value|content|topic|query|user_input|input_text|string(?:_[a-z0-9]+)?|text_[a-z0-9]+)$/i;
const TEXT_ENCODER_CLASS = /CLIPTextEncode|TextEncode|StringConstant|PrimitiveString|Text Multiline|CR Text/i;

function leafKey(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}

function isSeedKey(name) {
  const leaf = leafKey(name);
  return leaf === "seed" || leaf === "noise_seed" || leaf.endsWith("_seed");
}

function isPromptWidget(node, name) {
  const leaf = leafKey(name);
  if (NON_USER_PROMPT_KEY.test(leaf)) return false;
  return TEXT_ENCODER_CLASS.test(node.class_type) || PROMPT_KEY.test(leaf);
}

function promptWidgetRank(name) {
  const leaf = leafKey(name).toLowerCase();
  if (leaf === "prompt" || leaf === "user_prompt" || leaf === "positive_prompt") return 0;
  if (leaf === "text" || leaf === "value") return 1;
  if (PROMPT_KEY.test(leaf) && leaf !== "instruction" && leaf !== "description") return 2;
  if (leaf === "instruction" || leaf === "description") return 4;
  return 3;
}

function byNodeId(a, b) {
  const partsA = String(a).split(":");
  const partsB = String(b).split(":");
  const len = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number(partsA[i]);
    const nb = Number(partsB[i]);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (partsA[i] !== partsB[i]) return partsA[i].localeCompare(partsB[i]);
  }
  return partsA.length - partsB.length;
}

function outputKindOf(classType) {
  return OUTPUTS[classType] ?? null;
}

/**
 * 工作流产出什么：有视频算视频，其次图片，再其次音频；什么都不产出返回 null。
 * 只看节点类型，不需要节点目录，「读取模型」时用。App Mode 选了输出时只看选中的。
 */
export function workflowOutputKind(raw) {
  let classes;
  if (isEditorFormat(raw)) {
    const live = raw.nodes.filter((node) => node.mode !== 2 && node.mode !== 4);
    const picked = new Set(
      [...(raw.extra?.linearData?.outputs ?? raw.extra?.appMode?.outputs ?? [])].map((entry) =>
        String(typeof entry === "object" && entry !== null ? entry.id ?? entry.nodeId : entry),
      ),
    );
    const selected = picked.size > 0 && raw.extra?.linearMode !== false ? live.filter((node) => picked.has(String(node.id))) : [];
    classes = (selected.length > 0 ? selected : live).map((node) => node.type);
    for (const def of raw.definitions?.subgraphs ?? []) {
      if (selected.length === 0) classes.push(...(def.nodes ?? []).filter((node) => node.mode !== 2 && node.mode !== 4).map((node) => node.type));
    }
  } else if (raw && typeof raw === "object") {
    classes = Object.values(raw).map((node) => node?.class_type);
  } else {
    return null;
  }
  const kinds = new Set(classes.map(outputKindOf).filter(Boolean));
  for (const kind of ["video", "image", "audio"]) if (kinds.has(kind)) return kind;
  return null;
}

/** 界面格式需要节点目录；返回目录里缺的节点类型。 */
export function missingNodeTypes(raw, objectInfo) {
  return isEditorFormat(raw) ? editorNodeTypes(raw).filter((type) => !objectInfo?.[type]) : [];
}

export function needsObjectInfo(raw) {
  return isEditorFormat(raw);
}

/** 读出可执行的图、App Mode 设置和作者固定住的种子。 */
export function prepareWorkflow(raw, objectInfo) {
  if (isEditorFormat(raw)) {
    const { graph, fixedSeeds, comboOptions } = convertEditorGraph(raw, objectInfo ?? {});
    return { graph, appMode: extractAppMode(raw, Object.keys(graph)), fixedSeeds, comboOptions, objectInfo: objectInfo ?? null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("工作流文件不是 ComfyUI 的格式");
  const graph = {};
  for (const [id, node] of Object.entries(raw)) {
    if (node && typeof node === "object" && typeof node.class_type === "string") {
      graph[id] = { ...node, inputs: { ...(node.inputs ?? {}) } };
    }
  }
  if (Object.keys(graph).length === 0) throw new Error("工作流文件里没有能执行的节点");
  return { graph, appMode: null, fixedSeeds: new Set(), comboOptions: objectInfo ? collectGraphComboOptions(graph, objectInfo) : {}, objectInfo: objectInfo ?? null };
}

function computeReachableFromOutputs(graph, activeOutputIds) {
  const seeds = (activeOutputIds ?? []).filter((id) => Boolean(graph[id]));
  if (seeds.length === 0) return null;
  const reachable = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    const node = graph[current];
    if (!node) continue;
    for (const value of Object.values(node.inputs ?? {})) {
      if (isLink(value) && graph[value[0]] && !reachable.has(value[0])) {
        reachable.add(value[0]);
        queue.push(value[0]);
      }
    }
  }
  return reachable;
}

// 没设 App Mode 时，仅从有效输出节点向上可达的节点集合中寻找正向提示词；
// 优先沿采样器 positive / guider / conditioning 口向上追踪；经过子图扩写或条件节点时，继续穿透到最上游的用户文本输入。
function positivePromptTarget(graph, activeOutputIds) {
  const isNonUserNode = (node) => NON_USER_TITLE.test(String(node?._meta?.title ?? "").trim());
  const textWidget = (nodeId, depth = 0, visited = new Set()) => {
    const node = graph[nodeId];
    if (!node || depth > 12 || visited.has(nodeId)) return null;
    visited.add(nodeId);

    const entries = Object.entries(node.inputs ?? {});
    const linkEntries = entries
      .filter(([name, value]) => isLink(value) && !NON_USER_PROMPT_KEY.test(leafKey(name)) && (isPromptWidget(node, name) || PROMPT_LINK_KEY.test(leafKey(name))))
      .sort(([a], [b]) => promptWidgetRank(a) - promptWidgetRank(b));

    for (const [, value] of linkEntries) {
      const upstream = textWidget(value[0], depth + 1, new Set(visited));
      if (upstream) return upstream;
    }

    if (isNonUserNode(node)) return null;

    const stringWidgets = entries
      .filter(([name, value]) => typeof value === "string" && isPromptWidget(node, name))
      .sort(([a], [b]) => promptWidgetRank(a) - promptWidgetRank(b));
    if (stringWidgets.length > 0) {
      return { nodeId, widget: stringWidgets[0][0] };
    }
    return null;
  };

  const reachable = computeReachableFromOutputs(graph, activeOutputIds);
  const allIds = Object.keys(graph).sort(byNodeId);
  const ids = reachable ? allIds.filter((id) => reachable.has(id)) : allIds;
  const negatives = new Set();
  const markNegative = (nodeId, depth = 0) => {
    const node = graph[nodeId];
    if (!nodeId || depth > 4 || negatives.has(nodeId) || !node) return;
    if (/ZeroOut/i.test(node.class_type || "")) return;
    negatives.add(nodeId);
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (isLink(value) && (isPromptWidget(node, name) || PROMPT_LINK_KEY.test(leafKey(name)))) {
        markNegative(value[0], depth + 1);
      }
    }
  };
  for (const id of ids) {
    const negative = graph[id].inputs?.negative;
    if (isLink(negative)) markNegative(negative[0]);
  }

  const traced = [];
  for (const rootKey of ["positive", "guider", "conditioning"]) {
    for (const id of ids) {
      const link = graph[id].inputs?.[rootKey];
      if (!isLink(link)) continue;
      if (rootKey === "conditioning" && negatives.has(link[0])) continue;
      const target = textWidget(link[0]);
      if (target && !isNonUserNode(graph[target.nodeId]) && (rootKey === "positive" || rootKey === "guider" || !negatives.has(target.nodeId))) {
        traced.push(target);
      }
    }
    if (traced.length > 0) break;
  }

  const scoreTarget = (candidate) => {
    const title = String(graph[candidate.nodeId]?._meta?.title ?? "").trim();
    const isPositiveTitle = POSITIVE_TITLE.test(title) ? 0 : 1;
    const isTopLevel = !candidate.nodeId.includes(":") ? 0 : 1;
    return [isPositiveTitle, isTopLevel, promptWidgetRank(candidate.widget)];
  };
  const compareTargets = (a, b) => {
    const sa = scoreTarget(a);
    const sb = scoreTarget(b);
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return byNodeId(a.nodeId, b.nodeId);
  };

  if (traced.length > 0) {
    traced.sort(compareTargets);
    return traced[0];
  }

  const fallbacks = [];
  for (const id of ids) {
    const node = graph[id];
    if (negatives.has(id) || isNonUserNode(node) || !TEXT_ENCODER_CLASS.test(node.class_type)) continue;
    const widgets = Object.entries(node.inputs ?? {})
      .filter(([name, value]) => typeof value === "string" && isPromptWidget(node, name))
      .sort(([a], [b]) => promptWidgetRank(a) - promptWidgetRank(b));
    if (widgets.length > 0) fallbacks.push({ nodeId: id, widget: widgets[0][0] });
  }
  if (fallbacks.length > 0) {
    fallbacks.sort(compareTargets);
    return fallbacks[0];
  }
  return null;
}

/**
 * 这次生成能填的位置：prompt 是提示词的位置（可能没有），media 按 image / video / audio
 * 列出素材节点。设了 App Mode 时只用作者挑出来的输入，否则自动找。
 */
export function inputTargets(prepared) {
  const { graph, appMode } = prepared;
  const media = { image: [], video: [], audio: [] };
  let prompt = null;
  if (appMode) {
    for (const input of appMode.inputs) {
      const node = graph[input.nodeId];
      if (!node) continue;
      const loader = LOADERS[node.class_type];
      if (loader && loader.widget === input.widget) {
        media[loader.kind].push({ nodeId: input.nodeId, widget: input.widget, mode: loader.mode ?? "annotated" });
      } else if (!prompt && typeof node.inputs[input.widget] === "string" && isPromptWidget(node, input.widget)) {
        prompt = { nodeId: input.nodeId, widget: input.widget, alsoBind: input.alsoBind ?? [] };
      }
    }
    return { prompt, media };
  }
  for (const id of Object.keys(graph).sort(byNodeId)) {
    const loader = LOADERS[graph[id].class_type];
    if (loader && loader.widget in graph[id].inputs) {
      media[loader.kind].push({ nodeId: id, widget: loader.widget, mode: loader.mode ?? "annotated" });
    }
  }
  return { prompt: positivePromptTarget(graph, outputNodeIds(prepared)), media };
}

/** 要取结果的输出节点：App Mode 选了就用选中的，否则用所有产出图片、视频、音频的节点。 */
export function outputNodeIds(prepared) {
  const picked = (prepared.appMode?.outputNodeIds ?? []).filter((id) => prepared.graph[id]);
  if (picked.length > 0) return picked;
  return Object.keys(prepared.graph)
    .filter((id) => outputKindOf(prepared.graph[id].class_type))
    .sort(byNodeId);
}

/** 每次提交换新种子，作者设成「固定」的除外；不然同样的输入 ComfyUI 会直接返回上次的结果。 */
export function randomizeSeeds(prepared, random = Math.random) {
  for (const [id, node] of Object.entries(prepared.graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isSeedKey(name) || typeof value !== "number" || prepared.fixedSeeds.has(`${id}.${name}`)) continue;
      node.inputs[name] = Math.floor(random() * 2 ** 48);
    }
  }
}

export function setInput(graph, target, value) {
  for (const bound of [target, ...(target.alsoBind ?? [])]) {
    if (graph[bound.nodeId]) graph[bound.nodeId].inputs[bound.widget] = value;
  }
}

const SIZE_GENERATOR_NODE = /^(Empty.*Latent|Wan\d*.*(?:ToVideo|Latent)|Hunyuan.*(?:ToVideo|Latent)|LTXV.*(?:ToVideo|Latent))/i;
const VIDEO_FRAME_NODE = /^(Empty.*LatentVideo|Wan\d*.*(?:ToVideo|Latent)|Hunyuan.*(?:ToVideo|Latent)|LTXV.*(?:ToVideo|Latent)|.*(?:ImageToVideo|ImgToVideo|VideoToVideo))/i;

const IMAGE_STANDARD_SIZES = {
  "1:1": ["1024x1024", "2048x2048", "2880x2880"],
  "16:9": ["1824x1024", "2752x1536", "3840x2160"],
  "9:16": ["1024x1824", "1536x2752", "2160x3840"],
  "4:3": ["1360x1024", "2304x1728", "3264x2448"],
  "3:4": ["1024x1360", "1728x2304", "2448x3264"],
  "3:2": ["1536x1024", "2496x1664", "3504x2336"],
  "2:3": ["1024x1536", "1664x2496", "2336x3504"],
  "4:5": ["1024x1280", "1792x2240", "2560x3200"],
  "5:4": ["1280x1024", "2240x1792", "3200x2560"],
  "21:9": ["2048x880", "3136x1344", "3808x1632"],
};

const PRESET_SIZE_TO_RATIO_TEXT = new Map(
  Object.entries(IMAGE_STANDARD_SIZES).flatMap(([ratioText, sizes]) => sizes.map((sz) => [sz, ratioText])),
);

function roundToStep(value, step) {
  return Math.max(step, Math.round(value / step) * step);
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function simplifyRatioText(w, h) {
  const presetRatio = PRESET_SIZE_TO_RATIO_TEXT.get(`${Math.round(w)}x${Math.round(h)}`);
  if (presetRatio) return presetRatio;
  const divisor = gcd(w, h);
  return `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
}

function parseAspectRatio(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0 && h > 0)) return null;
  return { ratio: w / h, text: `${match[1]}:${match[2]}` };
}

function parseExactPixels(raw) {
  const exact = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(String(raw || ""));
  if (!exact) return null;
  const w = Number(exact[1]);
  const h = Number(exact[2]);
  return w > 0 && h > 0 ? { exactW: w, exactH: h } : null;
}

function imageTierIndex(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "1k" || key === "low") return 0;
  if (key === "2k" || key === "medium") return 1;
  if (key === "4k" || key === "high") return 2;
  return -1;
}

function resolveImageTierSize(tierIdx, ratioValue, ratioText) {
  const canonical = ratioText && IMAGE_STANDARD_SIZES[ratioText]
    ? ratioText
    : Object.keys(IMAGE_STANDARD_SIZES).find((candidate) => {
        const [cw, ch] = candidate.split(":").map(Number);
        return Math.abs(cw / ch - ratioValue) < 0.015;
      });
  const standard = canonical ? IMAGE_STANDARD_SIZES[canonical]?.[tierIdx] : undefined;
  if (standard) {
    const [exactW, exactH] = standard.split("x").map(Number);
    return { exactW, exactH };
  }
  const pixels = [1_048_576, 4_194_304, 8_294_400][tierIdx];
  let width = Math.round(Math.sqrt(pixels * ratioValue) / 16) * 16;
  let height = Math.round((width / ratioValue) / 16) * 16;
  while (width * height > pixels || Math.max(width, height) > 3840) {
    if (width >= height) {
      width -= 16;
      height = Math.round((width / ratioValue) / 16) * 16;
    } else {
      height -= 16;
      width = Math.round((height * ratioValue) / 16) * 16;
    }
  }
  return { exactW: Math.max(16, width), exactH: Math.max(16, height) };
}

function resolveLatentStep(classType, isVideo, objectInfo) {
  const declaredStep = Number(objectInfo?.[classType]?.input?.required?.width?.[1]?.step);
  if (Number.isFinite(declaredStep) && declaredStep > 0) return declaredStep;
  if (/LTX/i.test(classType)) return 32;
  if (isVideo || /(?:SD3|Flux|Hunyuan|Wan|Mochi|Lumina|AuraFlow|Chroma|Qwen|Cosmos|StepVideo|SkyReels|CogVideo)/i.test(classType)) {
    return 16;
  }
  return 8;
}

function resolveRequestedDimensions({ exactPixels, resRaw, isVideo, effectiveRatio, effectiveRatioText }) {
  if (exactPixels) return exactPixels;
  const key = String(resRaw || "").trim().toLowerCase();
  if (!key || key === "auto") return null;
  if (!isVideo) {
    const tierIdx = imageTierIndex(key);
    if (tierIdx >= 0) {
      return resolveImageTierSize(tierIdx, effectiveRatio, effectiveRatioText);
    }
  }
  const square = effectiveRatio !== null && Math.abs(effectiveRatio - 1) < 0.01;
  if (key === "1k") return { shortSide: square ? 1024 : 1080 };
  if (key === "2k") return { shortSide: square ? 2048 : 1440 };
  if (key === "4k") return { shortSide: square ? 4096 : 2160 };
  const map = {
    "480": 480,
    "480p": 480,
    "720": 720,
    "720p": 720,
    "768": 768,
    "768p": 768,
    "1080": 1080,
    "1080p": 1080,
    "1440": 1440,
    "1440p": 1440,
    "2160": 2160,
    "2160p": 2160,
  };
  return map[key] ? { shortSide: map[key] } : null;
}

function detectWorkflowFps(graph) {
  let hasLtx = false;
  let hasWan = false;
  for (const node of Object.values(graph)) {
    const type = String(node.class_type ?? "");
    if (/LTX/i.test(type)) hasLtx = true;
    if (/Wan/i.test(type)) hasWan = true;
    for (const key of ["fps", "frame_rate"]) {
      const value = node.inputs?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  if (hasLtx) return 25;
  if (hasWan) return 16;
  return 24;
}

/**
 * 将 BeefTV 统一请求里的宽高比、分辨率、时长映射到工作流节点参数。
 * 请求未指定对应字段时保留工作流原值。
 */
export function applyWorkflowParameters(prepared, request) {
  const aspectRaw = String(request?.aspectRatio || request?.output?.aspectRatio || "").trim();
  const resRaw = String(request?.resolution || request?.output?.resolution || "").trim();
  const duration = Number(request?.duration || request?.output?.duration || 0);
  const { graph, appMode, comboOptions, objectInfo } = prepared;
  const graphClasses = Object.values(graph).map((node) => node?.class_type);
  const inferredKind = ["video", "image", "audio"].find((kind) => graphClasses.some((cls) => OUTPUTS[cls] === kind)) ?? "";
  const capability = String(request?.capability || inferredKind).trim().toLowerCase();
  const isVideo = capability === "video";

  const ratioInfo = parseAspectRatio(aspectRaw);
  const exactPixels = parseExactPixels(resRaw) ?? parseExactPixels(aspectRaw);
  const exactRatio = exactPixels
    ? { ratio: exactPixels.exactW / exactPixels.exactH, text: simplifyRatioText(exactPixels.exactW, exactPixels.exactH) }
    : null;
  const effectiveRatioInfo = exactRatio ?? ratioInfo;
  const resCheck = resolveRequestedDimensions({
    exactPixels,
    resRaw,
    isVideo,
    effectiveRatio: effectiveRatioInfo?.ratio ?? 1,
    effectiveRatioText: effectiveRatioInfo?.text ?? "",
  });
  const hasDuration = Number.isFinite(duration) && duration > 0;
  if (!effectiveRatioInfo && !resCheck && !hasDuration) return;
  const appModeWidgets = new Set((appMode?.inputs ?? []).map((item) => `${item.nodeId}.${item.widget}`));
  const appModeSizeNodes = new Set(
    (appMode?.inputs ?? [])
      .filter((item) => item.widget === "width" || item.widget === "height")
      .map((item) => item.nodeId),
  );
  const appModeRatioNodes = new Set(
    (appMode?.inputs ?? [])
      .filter((item) => item.widget === "aspect_ratio" || item.widget === "ratio")
      .map((item) => item.nodeId),
  );
  const appModeRatioLinkedNodes = new Set(appModeRatioNodes);
  if (appModeRatioLinkedNodes.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, node] of Object.entries(graph)) {
        if (appModeRatioLinkedNodes.has(id)) continue;
        for (const value of Object.values(node?.inputs ?? {})) {
          if (isLink(value) && appModeRatioLinkedNodes.has(String(value[0]))) {
            appModeRatioLinkedNodes.add(id);
            changed = true;
            break;
          }
        }
      }
    }
  }
  const workflowFps = isVideo && hasDuration ? detectWorkflowFps(graph) : 24;
  const hasAppModeInputs = Boolean(appMode?.inputs?.length);
  const reachableIds = computeReachableFromOutputs(graph, outputNodeIds(prepared));

  // 先处理各节点的比例下拉约束，再统一计算潜空间宽高，避免节点顺序影响比例一致性。
  const keptNodeRatio = new Map();
  let anyRatioAccepted = false;
  let anyRatioRejected = false;
  let workflowRejectedRatio;
  if (effectiveRatioInfo) {
    for (const [id, node] of Object.entries(graph)) {
      const inputs = node.inputs ?? {};
      for (const key of Object.keys(inputs)) {
        const leaf = leafKey(key);
        if (leaf !== "aspect_ratio" && leaf !== "ratio") continue;
        const allowImageAutoRatio = !hasAppModeInputs && (!reachableIds || reachableIds.has(id));
        if (!isVideo && !allowImageAutoRatio && !appModeWidgets.has(`${id}.${key}`) && !appModeWidgets.has(`${id}.${leaf}`)) continue;
        if (typeof inputs[key] !== "string") continue;
        const allowed = comboOptions?.[`${id}.${key}`];
        if (Array.isArray(allowed) && allowed.length > 0) {
          const matched = allowed.find((opt) => opt.trim().toLowerCase() === effectiveRatioInfo.text.toLowerCase());
          if (matched !== undefined) {
            inputs[key] = matched;
            anyRatioAccepted = true;
          } else {
            const kept = parseAspectRatio(inputs[key].trim())?.ratio ?? null;
            keptNodeRatio.set(id, kept);
            if (!anyRatioRejected) {
              anyRatioRejected = true;
              workflowRejectedRatio = kept;
            }
          }
          continue;
        }
        if (/^(\d+(?:\.\d+)?:\d+(?:\.\d+)?|auto|adaptive)$/i.test(inputs[key].trim())) {
          inputs[key] = effectiveRatioInfo.text;
          anyRatioAccepted = true;
        }
      }
    }
  }

  for (const [id, node] of Object.entries(graph)) {
    const inputs = node.inputs ?? {};
    const classType = String(node.class_type ?? "");
    const allowImageLatent = !hasAppModeInputs && (!reachableIds || reachableIds.has(id));
    const shouldResizeLatent =
      ((isVideo || allowImageLatent) && SIZE_GENERATOR_NODE.test(classType)) ||
      appModeSizeNodes.has(id) ||
      (appModeRatioLinkedNodes.has(id) && SIZE_GENERATOR_NODE.test(classType)) ||
      appModeRatioNodes.has(id);

    if ((effectiveRatioInfo || resCheck) && shouldResizeLatent && typeof inputs.width === "number" && typeof inputs.height === "number") {
      const keptOverride = keptNodeRatio.has(id)
        ? keptNodeRatio.get(id)
        : ((isVideo || !hasAppModeInputs || appModeRatioLinkedNodes.has(id)) && anyRatioRejected && !anyRatioAccepted ? workflowRejectedRatio : undefined);
      const ratioRejected = keptOverride !== undefined;
      const fallbackRatio = inputs.width / Math.max(1, inputs.height);
      const effectiveRatio = ratioRejected ? (keptOverride ?? fallbackRatio) : (effectiveRatioInfo?.ratio ?? fallbackRatio);
      const effectiveRatioText = ratioRejected ? simplifyRatioText(effectiveRatio * 1000, 1000) : (effectiveRatioInfo?.text ?? "");
      const step = resolveLatentStep(classType, isVideo, objectInfo);
      const nodeResInfo = resolveRequestedDimensions({
        exactPixels,
        resRaw,
        isVideo,
        effectiveRatio,
        effectiveRatioText,
      });
      const shortSide = nodeResInfo?.shortSide ?? (ratioRejected && nodeResInfo?.exactW && nodeResInfo?.exactH ? Math.min(nodeResInfo.exactW, nodeResInfo.exactH) : null);
      if (!ratioRejected && nodeResInfo?.exactW && nodeResInfo?.exactH) {
        inputs.width = roundToStep(nodeResInfo.exactW, step);
        inputs.height = roundToStep(nodeResInfo.exactH, step);
      } else if (shortSide) {
        if (effectiveRatio >= 1) {
          inputs.height = roundToStep(shortSide, step);
          inputs.width = roundToStep(shortSide * effectiveRatio, step);
        } else {
          inputs.width = roundToStep(shortSide, step);
          inputs.height = roundToStep(shortSide / effectiveRatio, step);
        }
      } else if (effectiveRatioInfo && !ratioRejected) {
        const area = Math.max(step * step, inputs.width * inputs.height);
        inputs.width = roundToStep(Math.sqrt(area * effectiveRatio), step);
        inputs.height = roundToStep(Math.sqrt(area / effectiveRatio), step);
      }
    }

    if (isVideo && hasDuration && !(classType in LOADERS)) {
      for (const key of ["seconds", "duration", "video_duration"]) {
        if (typeof inputs[key] === "number" && Number.isFinite(inputs[key])) {
          inputs[key] = duration;
        }
      }
      if (VIDEO_FRAME_NODE.test(classType)) {
        const frameKey = ["length", "frames", "num_frames"].find((k) => typeof inputs[k] === "number" && Number.isFinite(inputs[k]));
        if (frameKey) {
          const localFps = typeof inputs.frame_rate === "number" && inputs.frame_rate > 0
            ? inputs.frame_rate
            : typeof inputs.fps === "number" && inputs.fps > 0
              ? inputs.fps
              : workflowFps;
          const mod4Plus1 = /Wan|Hunyuan|LTX|Mochi/i.test(classType) || (inputs[frameKey] - 1) % 4 === 0;
          inputs[frameKey] = mod4Plus1
            ? Math.max(5, Math.round((duration * localFps) / 4) * 4 + 1)
            : Math.max(1, Math.round(duration * localFps));
        }
      }
    }
  }
}
