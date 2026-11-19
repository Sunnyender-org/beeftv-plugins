// 无限星河 AI (Infistar) 渠道常量、官方预置模型目录与旧配置升级规则（对照 https://doc.infistar.cc/api-overview）

export const DEFAULT_BASE_URL = "https://infistar.cc";
export const INFISTAR_CHANNEL_ID = "infistar";
export const INFISTAR_CHANNEL_NAME = "无限星河 AI";
export const INFISTAR_CHANNEL_ICON = "https://cdn.jsdelivr.net/gh/Sunnyender-org/beeftv-plugins@v0.3.3/assets/partner-infistar.svg";
export const INFISTAR_KEYS_URL = "https://www.infistar.cc/register?aff=KBR9PG8Z&ref_source=link";
export const INFISTAR_WEBSITE_URL = "https://www.infistar.cc/register?aff=KBR9PG8Z&ref_source=link";
export const INFISTAR_PROMO_TEXT = "专属链接注册领 5 元体验额度 · 部分模型低至官方 0.1 折";
export const INFISTAR_PROVIDER_INTRO =
  "无限星河 AI（Infistar.cc）提供多模型统一 API 网关，聚合 Claude、GPT、Gemini、DeepSeek、Qwen 及主流图像与视频生成模型，支持人民币结算与国内直连加速；通过 BeefTV 专属链接注册可领 5 元体验额度。";

export const INFISTAR_LOGO_SVG_SPEC = {
  viewBox: "0 0 1024 1024",
  backgroundRadius: 296,
  gradientStops: [
    { offset: "0", color: "#2563EB" },
    { offset: "0.6", color: "#6366F1" },
    { offset: "1", color: "#8B5CF6" },
  ],
};

/**
 * @param {any} createElement
 * @param {Record<string, any>} [props]
 */
export function renderInfistarLogoSvg(createElement, { size = 18, className, style, ...rest } = {}) {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: INFISTAR_LOGO_SVG_SPEC.viewBox,
      fill: "none",
      className,
      style: { flex: "none", lineHeight: 1, ...style },
      ...rest,
    },
    createElement(
      "defs",
      null,
      createElement(
        "linearGradient",
        { id: "infistar-plugin-bg", x1: "0", y1: "0", x2: "1", y2: "1" },
        ...INFISTAR_LOGO_SVG_SPEC.gradientStops.map((stop, idx) =>
          createElement("stop", { key: idx, offset: stop.offset, stopColor: stop.color }),
        ),
      ),
      createElement(
        "clipPath",
        { id: "infistar-plugin-front" },
        createElement("rect", {
          x: -400,
          y: 512,
          width: 1824,
          height: 1000,
          transform: "rotate(-27 512 512)",
        }),
      ),
    ),
    createElement("rect", {
      width: 1024,
      height: 1024,
      rx: INFISTAR_LOGO_SVG_SPEC.backgroundRadius,
      fill: "url(#infistar-plugin-bg)",
    }),
    createElement(
      "g",
      {
        transform: "translate(512 512) scale(0.82) translate(-512 -512)",
        fill: "none",
        stroke: "#FFFFFF",
        strokeWidth: 72,
        strokeLinecap: "round",
      },
      createElement("ellipse", {
        cx: 512,
        cy: 512,
        rx: 325,
        ry: 88,
        transform: "rotate(-27 512 512)",
      }),
      createElement("circle", {
        cx: 512,
        cy: 512,
        r: 170,
        fill: "#5559EF",
        stroke: "none",
      }),
      createElement("circle", {
        cx: 512,
        cy: 512,
        r: 206,
      }),
      createElement(
        "g",
        { clipPath: "url(#infistar-plugin-front)" },
        createElement("ellipse", {
          cx: 512,
          cy: 512,
          rx: 325,
          ry: 88,
          transform: "rotate(-27 512 512)",
        }),
      ),
    ),
  );
}

function normalizeInfistarBaseUrl(raw) {
  let clean = String(raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (!clean) return DEFAULT_BASE_URL;
  clean = clean.replace(/\/v1$/i, "");
  return clean || DEFAULT_BASE_URL;
}

function createTextCapability({ thinking = false, maxImages = 0, maxVideos = 0 } = {}) {
  return {
    version: 1,
    text: {
      references: {
        promptMaxChars: 32000,
        maxImages,
        maxImageBytes: maxImages > 0 ? 10 * 1024 * 1024 : 0,
        maxVideos,
        maxVideoBytes: maxVideos > 0 ? 20 * 1024 * 1024 : 0,
      },
      streaming: true,
      thinking,
    },
  };
}

const GEMINI_IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

const SEEDREAM_2K_SIZES = [
  "2048x2048",
  "2560x1440",
  "1440x2560",
  "2304x1728",
  "1728x2304",
  "2496x1664",
  "1664x2496",
  "3024x1296",
];

const STANDARD_1K_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1280x720",
  "720x1280",
];

const SINGLE_REF_VIDEO_REFERENCES = {
  promptMaxChars: 2000,
  minImages: 0,
  maxImages: 1,
  maxImageBytes: 20 * 1024 * 1024,
  minImageWidth: 0,
  maxImageWidth: 0,
  minImageHeight: 0,
  maxImageHeight: 0,
  minImageAspect: 0,
  maxImageAspect: 0,
  minImagePixels: 0,
  maxImagePixels: 0,
  maxVideos: 0,
  maxVideoBytes: 0,
  minVideoDurationSeconds: 0,
  maxVideoDurationSeconds: 0,
  maxVideoTotalDurationSeconds: 0,
  minVideoWidth: 0,
  maxVideoWidth: 0,
  minVideoHeight: 0,
  maxVideoHeight: 0,
  minVideoAspect: 0,
  maxVideoAspect: 0,
  minVideoPixels: 0,
  maxVideoPixels: 0,
  maxAudios: 0,
  maxAudioBytes: 0,
  minAudioDurationSeconds: 0,
  maxAudioDurationSeconds: 0,
  maxAudioTotalDurationSeconds: 0,
};

function createGeminiImageCapability({ maxImages = 8, sizes = GEMINI_IMAGE_RATIOS } = {}) {
  return {
    version: 1,
    image: {
      references: {
        promptMaxChars: 8000,
        maxImages,
        maxImageBytes: 10 * 1024 * 1024,
        maskSupported: false,
      },
      size: {
        parameter: "aspectRatio",
        values: sizes,
        default: "1:1",
        allowCustom: false,
      },
      quality: {
        supported: true,
        values: ["1K", "2K", "4K"],
        default: "2K",
      },
      transparentBackground: { supported: false, default: false },
      sequentialGeneration: { supported: false, default: false },
      responseFormat: { supported: false },
      outputFormat: { supported: false },
      maxOutputs: 4,
    },
  };
}

function createOpenAIImageCapability({
  sizes = STANDARD_1K_SIZES,
  defaultSize = "1024x1024",
  maxImages = 4,
  maskSupported = false,
  qualityValues = [],
  defaultQuality = "auto",
  transparentBackground = false,
} = {}) {
  return {
    version: 1,
    image: {
      references: {
        promptMaxChars: 4000,
        maxImages,
        maxImageBytes: 10 * 1024 * 1024,
        maskSupported,
      },
      size: {
        parameter: "size",
        values: sizes,
        default: defaultSize,
        allowCustom: true,
      },
      quality: {
        supported: qualityValues.length > 0,
        values: qualityValues,
        default: defaultQuality,
      },
      transparentBackground: { supported: transparentBackground, default: false },
      sequentialGeneration: { supported: false, default: false },
      responseFormat: { supported: false },
      outputFormat: { supported: false },
      maxOutputs: 4,
    },
  };
}

function createVideoCapability({
  minDuration = 4,
  maxDuration = 15,
  defaultDuration = 5,
  durationValues = null,
  ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  defaultRatio = "16:9",
  resolutions = ["480p", "720p"],
  defaultResolution = "720p",
  operations = ["text_to_video", "image_to_video"],
  defaultOperation = "text_to_video",
  maxImages = 1,
} = {}) {
  return {
    version: 1,
    video: {
      references: {
        ...SINGLE_REF_VIDEO_REFERENCES,
        maxImages,
      },
      duration: durationValues
        ? { selection: "enum", values: durationValues, default: defaultDuration }
        : { selection: "range", min: minDuration, max: maxDuration, step: 1, default: defaultDuration },
      ratios,
      defaultRatio,
      resolutions,
      defaultResolution,
      generateAudio: { supported: false, default: false },
      watermark: { supported: false, default: false },
      operations,
      defaultOperation,
    },
  };
}

export const INFISTAR_PRESET_MODELS = [
  // ── 文本与多模态对话模型 (POST /v1/chat/completions) ──
  {
    model: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    family: "Claude 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    family: "Claude 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    family: "Claude 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "gpt-6.2-sol",
    displayName: "GPT-6.2 Sol",
    family: "GPT 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    family: "GPT 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    family: "Gemini 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10, maxVideos: 4 }),
  },
  {
    model: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    family: "Gemini 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10, maxVideos: 4 }),
  },
  {
    model: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    family: "Gemini 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10, maxVideos: 4 }),
  },
  {
    model: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "qwen4-max",
    displayName: "Qwen 4 Max",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "glm-5.3",
    displayName: "GLM-5.3",
    family: "GLM 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "kimi-k3.1-pro",
    displayName: "Kimi K3.1 Pro",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "MiniMax-M3.1-Flash",
    displayName: "MiniMax M3.1 Flash",
    family: "MiniMax 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },

  // ── Gemini 原生图像生成模型 (POST /v1beta/models/{model}:generateContent) ──
  {
    model: "gemini-nano-banana-2.1",
    displayName: "Gemini Nano Banana 2.1",
    family: "Gemini 图像",
    capability: "image",
    protocol: "infistar-gemini-image",
    endpoint: "POST /v1beta/models/{model}:generateContent",
    capabilityConfig: createGeminiImageCapability({ maxImages: 8 }),
  },
  {
    model: "gemini-3-pro-image",
    displayName: "Gemini 3 Pro Image",
    family: "Gemini 图像",
    capability: "image",
    protocol: "infistar-gemini-image",
    endpoint: "POST /v1beta/models/{model}:generateContent",
    capabilityConfig: createGeminiImageCapability({ maxImages: 8 }),
  },
  {
    model: "gemini-3.1-flash-image",
    displayName: "Gemini 3.1 Flash Image",
    family: "Gemini 图像",
    capability: "image",
    protocol: "infistar-gemini-image",
    endpoint: "POST /v1beta/models/{model}:generateContent",
    capabilityConfig: createGeminiImageCapability({ maxImages: 8 }),
  },
  {
    model: "gemini-3.1-flash-lite-image",
    displayName: "Gemini 3.1 Flash Lite Image",
    family: "Gemini 图像",
    capability: "image",
    protocol: "infistar-gemini-image",
    endpoint: "POST /v1beta/models/{model}:generateContent",
    capabilityConfig: createGeminiImageCapability({ maxImages: 8 }),
  },

  // ── OpenAI 兼容图像生成与编辑模型 (POST /v1/images/generations & /edits) ──
  {
    model: "doubao-seedream-5-0-260128",
    displayName: "Doubao Seedream 5.0 Lite",
    family: "Seedream 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: SEEDREAM_2K_SIZES,
      defaultSize: "2048x2048",
      maxImages: 4,
    }),
  },
  {
    model: "doubao-seedream-4-0-250828",
    displayName: "Doubao Seedream 4.0",
    family: "Seedream 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: SEEDREAM_2K_SIZES,
      defaultSize: "2048x2048",
      maxImages: 4,
    }),
  },
  {
    model: "gpt-image-2.5-flare",
    displayName: "GPT Image 2.5 Flare",
    family: "GPT 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      defaultSize: "1024x1024",
      maxImages: 4,
      maskSupported: true,
      qualityValues: ["low", "medium", "high"],
      defaultQuality: "medium",
      transparentBackground: true,
    }),
  },
  {
    model: "gpt-image-2.5-sunburst",
    displayName: "GPT Image 2.5 Sunburst",
    family: "GPT 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      defaultSize: "1024x1024",
      maxImages: 4,
      maskSupported: true,
      qualityValues: ["low", "medium", "high"],
      defaultQuality: "medium",
      transparentBackground: true,
    }),
  },
  {
    model: "gpt-image-2",
    displayName: "GPT Image 2",
    family: "GPT 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      defaultSize: "1024x1024",
      maxImages: 4,
      maskSupported: true,
      qualityValues: ["low", "medium", "high"],
      defaultQuality: "medium",
      transparentBackground: true,
    }),
  },
  {
    model: "qwen-image-2.0-pro",
    displayName: "Qwen Image 2.0 Pro",
    family: "Qwen 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 3,
    }),
  },
  {
    model: "qwen-image-2.0",
    displayName: "Qwen Image 2.0",
    family: "Qwen 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 3,
    }),
  },
  {
    model: "wan2.7-image-pro",
    displayName: "Wan 2.7 Image Pro",
    family: "Wan 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 3,
    }),
  },
  {
    model: "wan2.7-image",
    displayName: "Wan 2.7 Image",
    family: "Wan 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 3,
    }),
  },
  {
    model: "grok-imagine-image-quality",
    displayName: "Grok Imagine Image Quality",
    family: "Grok 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 2,
    }),
  },
  {
    model: "grok-imagine-image",
    displayName: "Grok Imagine Image",
    family: "Grok 图像",
    capability: "image",
    protocol: "infistar-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: createOpenAIImageCapability({
      sizes: STANDARD_1K_SIZES,
      defaultSize: "1024x1024",
      maxImages: 2,
    }),
  },

  // ── 异步视频生成模型 (POST /v1/videos multipart) ──
  {
    model: "doubao-seedance-2-5-260628",
    displayName: "Seedance 2.5",
    family: "Seedance 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 4,
      maxDuration: 15,
      defaultDuration: 5,
      resolutions: ["480p", "720p", "1080p"],
      defaultResolution: "720p",
    }),
  },
  {
    model: "doubao-seedance-2-0-260128",
    displayName: "Seedance 2.0",
    family: "Seedance 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 4,
      maxDuration: 15,
      defaultDuration: 5,
      resolutions: ["480p", "720p", "1080p", "4K"],
      defaultResolution: "720p",
    }),
  },
  {
    model: "doubao-seedance-2-0-fast-260128",
    displayName: "Seedance 2.0 Fast",
    family: "Seedance 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 4,
      maxDuration: 15,
      defaultDuration: 5,
      resolutions: ["480p", "720p"],
      defaultResolution: "720p",
    }),
  },
  {
    model: "doubao-seedance-2.0-mini",
    displayName: "Seedance 2.0 Mini",
    family: "Seedance 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 4,
      maxDuration: 15,
      defaultDuration: 5,
      resolutions: ["480p", "720p"],
      defaultResolution: "720p",
    }),
  },
  {
    model: "MiniMax-H3",
    displayName: "MiniMax H3",
    family: "MiniMax 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 4,
      maxDuration: 30,
      defaultDuration: 6,
      resolutions: ["480p", "768p", "1080p", "2K"],
      defaultResolution: "768p",
    }),
  },
  {
    model: "wan3.0-video",
    displayName: "Wan 3.0 Video",
    family: "Wan 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 2,
      maxDuration: 30,
      defaultDuration: 5,
      resolutions: ["480p", "720p", "1080p"],
      defaultResolution: "480p",
    }),
  },
  {
    model: "wan2.7-i2v",
    displayName: "Wan 2.7 I2V",
    family: "Wan 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 5,
      maxDuration: 10,
      defaultDuration: 5,
      durationValues: [5, 10],
      resolutions: ["480p", "720p", "1080p"],
      defaultResolution: "720p",
      operations: ["image_to_video"],
      defaultOperation: "image_to_video",
      maxImages: 1,
    }),
  },
  {
    model: "wan2.7-t2v",
    displayName: "Wan 2.7 T2V",
    family: "Wan 视频",
    capability: "video",
    protocol: "infistar-video",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      minDuration: 5,
      maxDuration: 10,
      defaultDuration: 5,
      durationValues: [5, 10],
      resolutions: ["480p", "720p", "1080p"],
      defaultResolution: "720p",
      operations: ["text_to_video"],
      defaultOperation: "text_to_video",
      maxImages: 0,
    }),
  },

  // ── JSON 异步视频生成模型 (POST /v1/videos JSON) ──
  {
    model: "kling-video-o1",
    displayName: "Kling Video O1",
    family: "Kling 视频",
    capability: "video",
    protocol: "infistar-video-json",
    endpoint: "POST /v1/videos",
    capabilityConfig: createVideoCapability({
      durationValues: [5, 10],
      defaultDuration: 5,
      ratios: ["16:9", "9:16", "1:1"],
      defaultRatio: "16:9",
      resolutions: ["720p", "1080p"],
      defaultResolution: "720p",
    }),
  },
];

function stableJson(value) {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

export function upgradeInfistarModelProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  if (!String(profile.protocol || "").startsWith("infistar-")) return profile;
  if (
    (typeof profile.imageCapabilitiesVersion === "string" && profile.imageCapabilitiesVersion.trim()) ||
    (typeof profile.videoCapabilitiesVersion === "string" && profile.videoCapabilitiesVersion.trim())
  ) {
    return profile;
  }
  const preset = INFISTAR_PRESET_MODELS.find((item) => item.model === profile.model);
  if (!preset) return profile;

  if (profile.capabilitySource !== "user") {
    if (stableJson(profile.capabilityConfig) === stableJson(preset.capabilityConfig)) {
      return profile;
    }
    return {
      ...profile,
      capabilityConfig: structuredClone(preset.capabilityConfig),
    };
  }
  return profile;
}

export function buildInfistarModelChannel({ apiKey, baseUrl, selectedModels, existingChannel }) {
  const cleanUrl = normalizeInfistarBaseUrl(baseUrl);
  const cleanKey = String(apiKey || "").trim();
  const presetModelIds = new Set(INFISTAR_PRESET_MODELS.map((item) => item.model));
  const chosenSet = new Set(
    Array.isArray(selectedModels) && selectedModels.length
      ? selectedModels
      : INFISTAR_PRESET_MODELS.map((item) => item.model),
  );
  const activePresets = INFISTAR_PRESET_MODELS.filter((item) => chosenSet.has(item.model));
  const customModels = Array.isArray(existingChannel?.models)
    ? existingChannel.models.filter((id) => !presetModelIds.has(id) && chosenSet.has(id))
    : [];
  const customProfiles = Array.isArray(existingChannel?.modelProfiles)
    ? existingChannel.modelProfiles.filter((profile) => !presetModelIds.has(profile.model) && chosenSet.has(profile.model))
    : [];
  const models = [...activePresets.map((item) => item.model), ...customModels];
  const modelProfiles = [
    ...activePresets.map((item) => ({
      model: item.model,
      displayName: item.displayName,
      capability: item.capability,
      protocol: item.protocol,
      authType: "bearer",
      ...(item.defaultOptions ? { defaultOptions: item.defaultOptions } : {}),
      capabilityConfig: structuredClone(item.capabilityConfig),
    })),
    ...customProfiles,
  ];

  return {
    id: INFISTAR_CHANNEL_ID,
    name: existingChannel?.name || INFISTAR_CHANNEL_NAME,
    scope: "user",
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    hasApiKey: Boolean(cleanKey || existingChannel?.hasApiKey),
    apiFormat: "openai",
    models,
    modelProfiles,
  };
}
