export const ART_CRITIQUE_SCHEMA_VERSION = 1;
export const ART_CRITIQUE_RUBRIC_VERSION = "2026-08-v1";
export const ART_CRITIQUE_PLUGIN_ID = "ai-art-critique";
export const ART_CRITIQUE_NODE_TYPE = "ai-art-critique";

export function createDefaultArtCritiqueState() {
  return {
    schemaVersion: ART_CRITIQUE_SCHEMA_VERSION,
    status: "idle",
  };
}

export function isArtCritiqueImageInput(node) {
  return Boolean(
    node &&
      node.type === "image" &&
      (node.metadata?.content || node.metadata?.previewContent || node.metadata?.storageKey),
  );
}

function compactSource(value) {
  if (value.length <= 2048) return value;
  return `${value.slice(0, 1024)}|${value.slice(-1024)}|${value.length}`;
}

/**
 * 只把输入图片身份信息做成轻量 FNV-1a 指纹，避免把大图片字符串直接保存进节点状态。
 */
export function artCritiqueSourceFingerprint(node) {
  const metadata = node?.metadata;
  const source = [
    node?.id || "",
    metadata?.storageKey || "",
    compactSource(metadata?.content || metadata?.previewContent || ""),
    metadata?.mimeType || "",
    metadata?.bytes || "",
    metadata?.naturalWidth || "",
    metadata?.naturalHeight || "",
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function artCritiqueCategoryLabel(category) {
  if (category === "composition") return "构图";
  if (category === "color") return "色彩";
  if (category === "lighting") return "光线";
  if (category === "proportion") return "比例";
  return "其他";
}

export function artCritiqueSeverityLabel(severity) {
  if (severity === "high") return "优先处理";
  if (severity === "medium") return "建议处理";
  return "可选优化";
}

export function artCritiqueStageLabel(stage) {
  if (stage === "preparing") return "准备图片";
  if (stage === "scene") return "理解场景";
  if (stage === "reviewing") return "检查视觉维度";
  if (stage === "aggregating") return "整理重点问题";
  if (stage === "grounding") return "定位问题区域";
  if (stage === "verifying") return "复核批改结果";
  if (stage === "annotating") return "生成标注";
  if (stage === "completed") return "分析完成";
  if (stage === "failed") return "分析失败";
  return "尚未分析";
}
