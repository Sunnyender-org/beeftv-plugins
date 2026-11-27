// HaryAI's models (https://haryai.com/models.json) as a BeefTV model channel.
// Every model uses a request format BeefTV already ships: chat-completion for
// chat, openai-image for images (BeefTV sends Seedream in Ark's JSON format
// itself), volcengine-ark-video for Seedance.

import { SNAPSHOT } from "./models.snapshot.js";

export const CHANNEL_ID = "haryai";
export const CHANNEL_NAME = "HaryAI";
export const BASE_URL = "https://api.haryai.com";
export const MODELS_URL = "https://haryai.com/models.json";

/** The live list, or the one shipped with this version when it can't be read. */
export async function loadModels() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(MODELS_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const { models } = await res.json();
    if (Array.isArray(models) && models.length) return models;
  } catch {
    // fall through
  }
  return SNAPSHOT;
}

// Seedance's reference limits per request (Volcengine Ark, "创建视频生成任务"):
// 2.5 takes 30 images, 10 videos and 10 audio clips; Flash 10 / 5 / 5. Clips
// run 2 to 30 s each, videos 30 s together.
function seedanceReferences(id) {
  const flash = id.includes("flash");
  return {
    promptMaxChars: 4000,
    minImages: 0,
    maxImages: flash ? 10 : 30,
    maxImageBytes: 30 * 1024 * 1024,
    maxVideos: flash ? 5 : 10,
    maxVideoBytes: 200 * 1024 * 1024,
    minVideoDurationSeconds: 2,
    maxVideoDurationSeconds: 30,
    maxVideoTotalDurationSeconds: 30,
    minVideoHeight: 480,
    maxAudios: flash ? 5 : 10,
    maxAudioBytes: 15 * 1024 * 1024,
    minAudioDurationSeconds: 2,
    maxAudioDurationSeconds: 30,
    maxAudioTotalDurationSeconds: 30,
    maxTotalReferences: 0,
  };
}

export function profileOf(m) {
  if (m.kind === "chat") {
    return {
      model: m.id,
      displayName: m.name,
      capability: "text",
      protocol: "chat-completion",
      authType: "bearer",
      capabilityConfig: {
        version: 1,
        text: {
          references: m.readsImages
            ? { promptMaxChars: 200000, maxImages: 10, maxImageBytes: 10 * 1024 * 1024 }
            : { promptMaxChars: 200000, maxImages: 0, maxImageBytes: 0 },
          streaming: true,
          thinking: true,
        },
      },
    };
  }
  if (m.kind === "image") {
    // No capability config: BeefTV knows Seedream's sizes, and turns a ratio
    // into pixels for the others.
    return { model: m.id, displayName: m.name, capability: "image", protocol: "openai-image", authType: "bearer" };
  }
  if (m.kind === "video") {
    const resolutions = m.resolutions?.length ? m.resolutions : ["480p", "720p"];
    return {
      model: m.id,
      displayName: m.id.endsWith("-unlock") ? `${m.name} Unlock` : m.name,
      capability: "video",
      protocol: "volcengine-ark-video",
      authType: "bearer",
      capabilityConfig: {
        version: 1,
        video: {
          references: seedanceReferences(m.id),
          duration: { selection: "range", min: m.seconds?.min ?? 4, max: m.seconds?.max ?? 15, step: 1, default: 5 },
          ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
          defaultRatio: "16:9",
          resolutions,
          defaultResolution: resolutions.includes("720p") ? "720p" : resolutions[0],
          generateAudio: { supported: true, default: true },
          watermark: { supported: true, default: false },
          operations: ["text_to_video", "image_to_video", "reference_to_video"],
          defaultOperation: "text_to_video",
          operationReferences: {
            text_to_video: { maxImages: 0, maxVideos: 0, maxAudios: 0 },
            image_to_video: { minImages: 1, maxImages: 2, maxVideos: 0, maxAudios: 0 },
          },
        },
      },
    };
  }
  return null;
}

/** The channel to write. Models the user added to it by hand are kept. */
export function buildChannel({ apiKey, models, existing }) {
  const profiles = models.map(profileOf).filter(Boolean);
  const ours = new Set(profiles.map((p) => p.model));
  const extraModels = (existing?.models || []).filter((id) => typeof id === "string" && !ours.has(id));
  const extraProfiles = (existing?.modelProfiles || []).filter((p) => p && extraModels.includes(p.model));
  return {
    id: CHANNEL_ID,
    name: CHANNEL_NAME,
    scope: "user",
    baseUrl: BASE_URL,
    apiKey,
    hasApiKey: Boolean(apiKey),
    apiFormat: "openai",
    models: [...profiles.map((p) => p.model), ...extraModels],
    modelProfiles: [...profiles, ...extraProfiles],
  };
}
