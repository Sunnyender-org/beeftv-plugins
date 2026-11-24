// Google Colab 插件常量：OAuth 公开参数、模型目录、Hugging Face 权重清单与显卡档位。

export const PLUGIN_ID = "beeftv-plugin-colab";
export const PROVIDER_ID = "colab";
export const DEFAULT_COLAB_ORIGIN = "https://colab.research.google.com";

// 与官方 google-colab-cli 相同的 Google Cloud SDK 公开客户端配置与远程授权落地页。
export const GOOGLE_OAUTH_CLIENT = {
  clientId: "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com",
  clientSecret: "d-FL95Q19q7MQmFpd7hHD0Ty",
  authUri: "https://accounts.google.com/o/oauth2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
  redirectUri: "https://sdk.cloud.google.com/applicationdefaultauthcode.html",
  userInfoUri: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/colaboratory",
  ],
};

export function buildGoogleAuthorizationUrl(oauth = GOOGLE_OAUTH_CLIENT) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    scope: oauth.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    token_usage: "remote",
  });
  return `${oauth.authUri}?${params.toString()}`;
}

// 本机插件控制接口默认端口范围（仅监听 127.0.0.1）。
export const CONTROL_SERVER_PORTS = [18971, 18972, 18973, 18974, 18975];
export const CONTROL_CLIENT_HEADER = "x-beeftv-colab";
export const DEFAULT_IDLE_STOP_MINUTES = 15;

export const COLAB_MODELS = [
  {
    id: "minimax-h3-image-4k",
    displayName: "MiniMax-H3-Image · 原生 4K",
    capability: "image",
    family: "h3",
    tier: "4k",
    minImages: 0,
    maxImages: 16,
    minVramMib: 35000,
    allowedAccelerators: ["G4", "A100", "H100"],
  },
  {
    id: "minimax-h3-image-2k",
    displayName: "MiniMax-H3-Image · 2K 标准",
    capability: "image",
    family: "h3",
    tier: "2k",
    minImages: 0,
    maxImages: 16,
    minVramMib: 35000,
    allowedAccelerators: ["G4", "A100", "H100"],
  },
  {
    id: "moss-image-sft",
    displayName: "MOSS-Image · 双语排版生图",
    capability: "image",
    family: "moss",
    tier: "sft",
    minImages: 0,
    maxImages: 4,
    minVramMib: 16000,
    allowedAccelerators: ["G4", "A100", "L4", "H100"],
  },
  {
    id: "moss-image-edit",
    displayName: "MOSS-Image · 指令改图",
    capability: "image",
    family: "moss",
    tier: "edit",
    minImages: 1,
    maxImages: 4,
    minVramMib: 16000,
    allowedAccelerators: ["G4", "A100", "L4", "H100"],
  },
];

export const MODEL_BY_ID = new Map(COLAB_MODELS.map((item) => [item.id, item]));

export const COMFYUI_REPO_URL = "https://github.com/Comfy-Org/ComfyUI.git";
export const COMFYUI_COMMIT = "0228a9d73cd7c2daf8f61fe13d56b12efe307171";

// 官方 Comfy-Org 权重仓库及精确版本，避免上游临时改名破坏线上用户。
export const HF_WEIGHT_SPECS = {
  h3_bf16: {
    repo: "Comfy-Org/MiniMax-H3-Image",
    revision: "892de7cb61df49753bf15145a711154803a355cb",
    files: [
      { path: "diffusion_models/minimax_h3_image_pruned_bf16.safetensors", subdir: "diffusion_models", bytes: 40234657162 },
      { path: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", subdir: "text_encoders", bytes: 15687142551 },
      { path: "vae/minimax_h3_image_vae_fp16.safetensors", subdir: "vae", bytes: 1168505312 },
    ],
    unet: "minimax_h3_image_pruned_bf16.safetensors",
    clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    vae: "minimax_h3_image_vae_fp16.safetensors",
  },
  h3_int8: {
    repo: "Comfy-Org/MiniMax-H3-Image",
    revision: "892de7cb61df49753bf15145a711154803a355cb",
    files: [
      { path: "diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", subdir: "diffusion_models", bytes: 20979314802 },
      { path: "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", subdir: "text_encoders", bytes: 15687142551 },
      { path: "vae/minimax_h3_image_vae_fp16.safetensors", subdir: "vae", bytes: 1168505312 },
    ],
    unet: "minimax_h3_image_pruned_int8_convrot.safetensors",
    clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    vae: "minimax_h3_image_vae_fp16.safetensors",
  },
  moss_bf16: {
    repo: "Comfy-Org/MOSS-Image",
    revision: "2929efe3cdd506c0a430bcfca70a9a8d805cc095",
    files: [
      { path: "diffusion_models/moss_image_sft_bf16.safetensors", subdir: "diffusion_models", bytes: 10164655808 },
      { path: "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors", subdir: "text_encoders", bytes: 7343591088 },
      { path: "vae/flux2-vae_small.safetensors", subdir: "vae", bytes: 249521340 },
      { path: "loras/moss_image_edit_lora_rank_64_bf16.safetensors", subdir: "loras", bytes: 297382216 },
    ],
    unet: "moss_image_sft_bf16.safetensors",
    clip: "qwen3.5_9b_w4a8_gptq.safetensors",
    vae: "flux2-vae_small.safetensors",
    editLora: "moss_image_edit_lora_rank_64_bf16.safetensors",
  },
  moss_int8: {
    repo: "Comfy-Org/MOSS-Image",
    revision: "2929efe3cdd506c0a430bcfca70a9a8d805cc095",
    files: [
      { path: "diffusion_models/moss_image_sft_int8_convrot.safetensors", subdir: "diffusion_models", bytes: 5413698958 },
      { path: "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors", subdir: "text_encoders", bytes: 7343591088 },
      { path: "vae/flux2-vae_small.safetensors", subdir: "vae", bytes: 249521340 },
      { path: "loras/moss_image_edit_lora_rank_64_bf16.safetensors", subdir: "loras", bytes: 297382216 },
    ],
    unet: "moss_image_sft_int8_convrot.safetensors",
    clip: "qwen3.5_9b_w4a8_gptq.safetensors",
    vae: "flux2-vae_small.safetensors",
    editLora: "moss_image_edit_lora_rank_64_bf16.safetensors",
  },
};

export const GPU_PREFERENCES = ["auto", "G4", "A100", "L4"];

export function resolveAcceleratorCandidates(gpuPreference, modelSpec) {
  const pref = GPU_PREFERENCES.includes(gpuPreference) ? gpuPreference : "auto";
  if (pref !== "auto") {
    return modelSpec.allowedAccelerators.includes(pref) ? [pref] : [];
  }
  return modelSpec.family === "h3" ? ["G4", "A100"] : ["G4", "A100", "L4"];
}

export function selectWeightProfileKey(family, accelerator, vramMib = 0) {
  if (family === "h3") {
    if (vramMib >= 70000 || (vramMib === 0 && (accelerator === "G4" || accelerator === "H100"))) {
      return "h3_bf16";
    }
    return "h3_int8";
  }
  if (vramMib >= 35000 || (vramMib === 0 && accelerator !== "L4")) {
    return "moss_bf16";
  }
  return "moss_int8";
}
