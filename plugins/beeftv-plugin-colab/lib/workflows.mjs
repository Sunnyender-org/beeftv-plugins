// MiniMax-H3-Image 与 MOSS-Image 的 ComfyUI 0.45.0 原生节点工作流构造器。

import { randomInt } from "node:crypto";
import { COLAB_MODELS, HF_WEIGHT_SPECS, MODEL_BY_ID, selectWeightProfileKey } from "./constants.mjs";

const DEFAULT_MOSS_NEGATIVE = "nsfw, worst quality, bad anatomy, watermark, jpeg artifact";

const H3_4K_PRESETS = {
  "1:1": [4096, 4096],
  "16:9": [5472, 3072],
  "9:16": [3072, 5472],
  "4:3": [4800, 3584],
  "3:4": [3584, 4800],
  "3:2": [5120, 3392],
  "2:3": [3392, 5120],
  "21:9": [6400, 2752],
};

const H3_2K_PRESETS = {
  "1:1": [2048, 2048],
  "16:9": [2688, 1536],
  "9:16": [1536, 2688],
  "4:3": [2368, 1792],
  "3:4": [1792, 2368],
  "3:2": [2496, 1664],
  "2:3": [1664, 2496],
  "21:9": [3136, 1344],
};

const MOSS_1MP_PRESETS = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 864],
  "3:4": [864, 1152],
  "3:2": [1248, 832],
  "2:3": [832, 1248],
  "21:9": [1536, 656],
};

const MOSS_2MP_PRESETS = {
  "1:1": [1440, 1440],
  "16:9": [1920, 1088],
  "9:16": [1088, 1920],
  "4:3": [1664, 1248],
  "3:4": [1248, 1664],
  "3:2": [1760, 1168],
  "2:3": [1168, 1760],
  "21:9": [2176, 928],
};

function alignToStep(value, step, min, max) {
  const rounded = Math.round(value / step) * step;
  return Math.max(min, Math.min(max, rounded));
}

function parseExplicitSize(raw, step, min, max) {
  const match = /^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const w = alignToStep(Number(match[1]), step, min, max);
  const h = alignToStep(Number(match[2]), step, min, max);
  return [w, h];
}

function parseRatioPair(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const rw = Number(match[1]);
  const rh = Number(match[2]);
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return null;
  return [rw, rh];
}

export function resolveDimensions({ family, tier, aspectRatio, quality }) {
  const ratioRaw = String(aspectRatio ?? "").trim();
  const qualityNorm = String(quality ?? "").trim().toLowerCase();

  if (family === "h3") {
    const step = 32;
    const explicit = parseExplicitSize(ratioRaw, step, 512, 6400);
    if (explicit) return { width: explicit[0], height: explicit[1] };
    const use4k = tier === "4k" || qualityNorm === "4k";
    const table = use4k ? H3_4K_PRESETS : H3_2K_PRESETS;
    if (table[ratioRaw]) return { width: table[ratioRaw][0], height: table[ratioRaw][1] };
    const pair = parseRatioPair(ratioRaw);
    if (pair) {
      const targetPixels = use4k ? 4096 * 4096 : 2048 * 2048;
      const w = Math.sqrt((targetPixels * pair[0]) / pair[1]);
      const h = (w * pair[1]) / pair[0];
      return {
        width: alignToStep(w, step, 512, 6400),
        height: alignToStep(h, step, 512, 6400),
      };
    }
    const fallback = table["1:1"];
    return { width: fallback[0], height: fallback[1] };
  }

  const step = 16;
  const explicit = parseExplicitSize(ratioRaw, step, 512, 2560);
  if (explicit) return { width: explicit[0], height: explicit[1] };
  const use2mp = qualityNorm === "2k" || qualityNorm === "4k";
  const table = use2mp ? MOSS_2MP_PRESETS : MOSS_1MP_PRESETS;
  if (table[ratioRaw]) return { width: table[ratioRaw][0], height: table[ratioRaw][1] };
  const pair = parseRatioPair(ratioRaw);
  if (pair) {
    const targetPixels = use2mp ? 1440 * 1440 : 1024 * 1024;
    const w = Math.sqrt((targetPixels * pair[0]) / pair[1]);
    const h = (w * pair[1]) / pair[0];
    return {
      width: alignToStep(w, step, 512, 2560),
      height: alignToStep(h, step, 512, 2560),
    };
  }
  const fallback = table["1:1"];
  return { width: fallback[0], height: fallback[1] };
}

export function normalizeH3Prompt(prompt, negativePrompt, imageCount) {
  let out = String(prompt ?? "").trim();
  if (imageCount > 0) {
    // 把画布里常见的 @图片1 / @图1 / 图片1 统一替换成 MiniMax-H3-Image 识别的 <Picture 1> 标记。
    out = out.replace(/@?(?:图片|图|image|picture)\s*([1-9]|1[0-6])(?![0-9>])/gi, (_m, idx) => `<Picture ${idx}>`);
    const hasAnyPictureTag = /<Picture\s+\d+>/i.test(out);
    if (!hasAnyPictureTag) {
      const refs = Array.from({ length: imageCount }, (_v, idx) => `<Picture ${idx + 1}>`).join(", ");
      out = `Using ${refs} as visual reference: ${out}`;
    }
  }
  const neg = String(negativePrompt ?? "").trim();
  if (neg) {
    out = `${out}\nAvoid: ${neg}`;
  }
  return out;
}

function nextSeed(explicitSeed) {
  const num = Number(explicitSeed);
  if (Number.isInteger(num) && num >= 0) return num;
  return randomInt(1, 2 ** 47);
}

function node(classType, inputs) {
  return { class_type: classType, inputs };
}

export function buildH3Workflow({ prompt, negativePrompt, width, height, seed, weightSpec, refFilenames = [] }) {
  const finalPrompt = normalizeH3Prompt(prompt, negativePrompt, refFilenames.length);
  const graph = {
    "1": node("UNETLoader", { unet_name: weightSpec.unet, weight_dtype: "default" }),
    "2": node("CLIPLoader", { clip_name: weightSpec.clip, type: "minimax", device: "default" }),
    "3": node("VAELoader", { vae_name: weightSpec.vae }),
  };

  const condInputs = {
    clip: ["2", 0],
    vae: ["3", 0],
    prompt: finalPrompt,
    width,
    height,
  };

  refFilenames.forEach((filename, index) => {
    const loadId = String(100 + index);
    graph[loadId] = node("LoadImage", { image: filename });
    condInputs[`images.image_${index + 1}`] = [loadId, 0];
  });

  graph["4"] = node("MiniMaxH3ImageConditioning", condInputs);
  graph["5"] = node("ConditioningZeroOut", { conditioning: ["4", 0] });
  graph["6"] = node("KSampler", {
    model: ["1", 0],
    seed: nextSeed(seed),
    steps: 6,
    cfg: 1.0,
    sampler_name: "euler",
    scheduler: "simple",
    positive: ["4", 0],
    negative: ["5", 0],
    latent_image: ["4", 1],
    denoise: 1.0,
  });
  graph["7"] = node("VAEDecode", { samples: ["6", 0], vae: ["3", 0] });
  graph["8"] = node("SaveImage", { images: ["7", 0], filename_prefix: "beeftv_colab/h3" });

  return { graph, outputNodeId: "8" };
}

export function buildMossT2IWorkflow({ prompt, negativePrompt, width, height, seed, weightSpec }) {
  const neg = String(negativePrompt ?? "").trim() || DEFAULT_MOSS_NEGATIVE;
  const graph = {
    "1": node("UNETLoader", { unet_name: weightSpec.unet, weight_dtype: "default" }),
    "2": node("SkipLayerGuidanceDiTSimple", {
      model: ["1", 0],
      double_layers: "",
      single_layers: "22",
      start_percent: 0.0,
      end_percent: 0.5,
    }),
    "3": node("CLIPLoader", { clip_name: weightSpec.clip, type: "moss_image", device: "default" }),
    "4": node("VAELoader", { vae_name: weightSpec.vae }),
    "5": node("CLIPTextEncode", { clip: ["3", 0], text: String(prompt ?? "").trim() }),
    "6": node("CLIPTextEncode", { clip: ["3", 0], text: neg }),
    "7": node("EmptyFlux2LatentImage", { width, height, batch_size: 1 }),
    "8": node("KSampler", {
      model: ["2", 0],
      seed: nextSeed(seed),
      steps: 25,
      cfg: 2.5,
      sampler_name: "er_sde",
      scheduler: "simple",
      positive: ["5", 0],
      negative: ["6", 0],
      latent_image: ["7", 0],
      denoise: 1.0,
    }),
    "9": node("VAEDecode", { samples: ["8", 0], vae: ["4", 0] }),
    "10": node("SaveImage", { images: ["9", 0], filename_prefix: "beeftv_colab/moss_t2i" }),
  };
  return { graph, outputNodeId: "10" };
}

export function buildMossEditWorkflow({ prompt, negativePrompt, aspectRatio, seed, weightSpec, refFilenames }) {
  const neg = String(negativePrompt ?? "").trim() || DEFAULT_MOSS_NEGATIVE;
  const graph = {
    "1": node("UNETLoader", { unet_name: weightSpec.unet, weight_dtype: "default" }),
    "2": node("LoraLoaderModelOnly", {
      model: ["1", 0],
      lora_name: weightSpec.editLora,
      strength_model: 1.0,
    }),
    "3": node("SkipLayerGuidanceDiTSimple", {
      model: ["2", 0],
      double_layers: "",
      single_layers: "22",
      start_percent: 0.0,
      end_percent: 1.0,
    }),
    "4": node("CLIPLoader", { clip_name: weightSpec.clip, type: "moss_image", device: "default" }),
    "5": node("VAELoader", { vae_name: weightSpec.vae }),
  };

  const imageInputs = {};
  refFilenames.forEach((filename, index) => {
    const loadId = String(100 + index * 2);
    const scaleId = String(101 + index * 2);
    graph[loadId] = node("LoadImage", { image: filename });
    graph[scaleId] = node("ImageScaleToTotalPixels", {
      image: [loadId, 0],
      upscale_method: "lanczos",
      megapixels: 1.0,
      resolution_steps: 16,
    });
    imageInputs[`images.image_${index}`] = [scaleId, 0];
  });

  const ratioRaw = String(aspectRatio ?? "").trim();
  if (!ratioRaw || ratioRaw === "auto") {
    graph["6"] = node("GetImageSize", { image: ["101", 0] });
    graph["7"] = node("EmptyFlux2LatentImage", {
      width: ["6", 0],
      height: ["6", 1],
      batch_size: 1,
    });
  } else {
    const dims = resolveDimensions({ family: "moss", tier: "edit", aspectRatio: ratioRaw, quality: "1k" });
    graph["7"] = node("EmptyFlux2LatentImage", {
      width: dims.width,
      height: dims.height,
      batch_size: 1,
    });
  }

  graph["8"] = node("TextEncodeMOSSImageEdit", {
    clip: ["4", 0],
    vae: ["5", 0],
    prompt: String(prompt ?? "").trim(),
    edit_format: "Moss-Image-Edit",
    image_strength: 1.0,
    ...imageInputs,
  });

  graph["9"] = node("TextEncodeMOSSImageEdit", {
    clip: ["4", 0],
    vae: ["5", 0],
    prompt: neg,
    edit_format: "Moss-Image-Edit",
    image_strength: 1.0,
    ...imageInputs,
  });

  graph["10"] = node("KSampler", {
    model: ["3", 0],
    seed: nextSeed(seed),
    steps: 30,
    cfg: 4.0,
    sampler_name: "euler",
    scheduler: "normal",
    positive: ["8", 0],
    negative: ["9", 0],
    latent_image: ["7", 0],
    denoise: 1.0,
  });
  graph["11"] = node("VAEDecode", { samples: ["10", 0], vae: ["5", 0] });
  graph["12"] = node("SaveImage", { images: ["11", 0], filename_prefix: "beeftv_colab/moss_edit" });

  return { graph, outputNodeId: "12" };
}

export function validateGenerationRequest(request) {
  const modelId = String(request?.model ?? "").trim();
  let modelSpec = MODEL_BY_ID.get(modelId);
  if (!modelSpec) {
    const supported = COLAB_MODELS.map((m) => m.id).join("、");
    return { ok: false, message: `Google Colab 插件里没有模型「${modelId || "未选择"}」，可选模型：${supported}` };
  }

  const prompt = String(request?.prompt ?? "").trim();
  if (!prompt) {
    return { ok: false, message: "请先填写画面描述提示词" };
  }

  const suppliedVideos = Array.isArray(request?.videos) ? request.videos.length : 0;
  const suppliedAudios = Array.isArray(request?.audios) ? request.audios.length : 0;
  if (suppliedVideos > 0 || suppliedAudios > 0) {
    return { ok: false, message: "当前生图模型不接收视频或音频参考素材" };
  }

  const images = (Array.isArray(request?.images) ? request.images : []).filter((item) => item?.role !== "mask");

  // 用户选了 MOSS 生图档位但连了参考图时，自动转入 MOSS 改图流程，省去手动切换模型。
  if (modelSpec.id === "moss-image-sft" && images.length > 0) {
    modelSpec = MODEL_BY_ID.get("moss-image-edit");
  }

  if (images.length < modelSpec.minImages) {
    return {
      ok: false,
      message: `「${modelSpec.displayName}」需要连入至少 ${modelSpec.minImages} 张参考图；如果不带参考图直接生图，请改选「MOSS-Image · 双语排版生图」`,
    };
  }

  if (images.length > modelSpec.maxImages) {
    return {
      ok: false,
      message: `「${modelSpec.displayName}」最多接收 ${modelSpec.maxImages} 张参考图，这次给了 ${images.length} 张`,
    };
  }

  return { ok: true, modelSpec, prompt, images };
}

export function compileGenerationPlan(
  request,
  { modelSpec: explicitModelSpec, accelerator = "G4", vramMib = 0, refFilenames = [] } = {},
) {
  const synthesizedImages =
    Array.isArray(request?.images) && request.images.length > 0
      ? request.images
      : refFilenames.map(() => ({ role: "reference" }));
  const checked = validateGenerationRequest({ ...request, images: synthesizedImages });
  if (!checked.ok) {
    throw new Error(checked.message);
  }
  const modelSpec = explicitModelSpec || checked.modelSpec;
  const { prompt } = checked;
  if (refFilenames.length < modelSpec.minImages) {
    throw new Error(`「${modelSpec.displayName}」需要至少 ${modelSpec.minImages} 张参考图`);
  }
  if (refFilenames.length > modelSpec.maxImages) {
    throw new Error(`「${modelSpec.displayName}」最多接收 ${modelSpec.maxImages} 张参考图`);
  }
  const profileKey = selectWeightProfileKey(modelSpec.family, accelerator, vramMib);
  const weightSpec = HF_WEIGHT_SPECS[profileKey];
  const aspectRatio = request?.aspectRatio ?? request?.size ?? "1:1";
  const quality = request?.quality ?? (modelSpec.tier === "4k" ? "4k" : modelSpec.tier === "2k" ? "2k" : "1k");
  const seed = request?.seed;
  const negativePrompt = request?.negativePrompt ?? "";

  if (modelSpec.family === "h3") {
    const { width, height } = resolveDimensions({
      family: "h3",
      tier: modelSpec.tier,
      aspectRatio,
      quality,
    });
    const { graph, outputNodeId } = buildH3Workflow({
      prompt,
      negativePrompt,
      width,
      height,
      seed,
      weightSpec,
      refFilenames,
    });
    return { modelSpec, profileKey, weightSpec, width, height, graph, outputNodeId };
  }

  if (modelSpec.tier === "edit") {
    const { graph, outputNodeId } = buildMossEditWorkflow({
      prompt,
      negativePrompt,
      aspectRatio,
      seed,
      weightSpec,
      refFilenames,
    });
    return { modelSpec, profileKey, weightSpec, width: 0, height: 0, graph, outputNodeId };
  }

  const { width, height } = resolveDimensions({
    family: "moss",
    tier: "sft",
    aspectRatio,
    quality,
  });
  const { graph, outputNodeId } = buildMossT2IWorkflow({
    prompt,
    negativePrompt,
    width,
    height,
    seed,
    weightSpec,
  });
  return { modelSpec, profileKey, weightSpec, width, height, graph, outputNodeId };
}
