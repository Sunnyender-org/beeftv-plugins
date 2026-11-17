export const ART_CRITIQUE_CATEGORY_COLORS = {
  composition: "#f97316",
  color: "#a855f7",
  lighting: "#eab308",
  proportion: "#06b6d4",
  other: "#ef4444",
};

export const ART_CRITIQUE_SEVERITY_COLORS = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

/**
 * 小于该跨度的框通常不是可读区域框，而是模型把两个点落在了同一条线上。
 */
export const MIN_ART_CRITIQUE_BOX_SPAN = 0.025;

export function targetPolygon(target) {
  if (!target || target.type === "global") return [];
  if (target.type === "points") return target.points || [];
  if (target.type === "box" && (target.points?.length || 0) >= 2) {
    const left = Math.min(target.points[0].x, target.points[1].x);
    const right = Math.max(target.points[0].x, target.points[1].x);
    const top = Math.min(target.points[0].y, target.points[1].y);
    const bottom = Math.max(target.points[0].y, target.points[1].y);
    return [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  }
  return target.points || [];
}

export function targetBounds(target) {
  const points = targetPolygon(target);
  if (!points.length) return { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(0.015, Math.max(...xs) - x),
    height: Math.max(0.015, Math.max(...ys) - y),
  };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

export function isRenderableArtCritiqueTarget(target) {
  if (!target) return false;
  if (target.type === "global") return true;
  if (!target.points?.length || target.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return false;
  }
  if (target.type === "point" || target.type === "points") return true;
  if (target.type === "box") {
    if (target.points.length < 2) return false;
    const [first, second] = target.points;
    return Math.abs(first.x - second.x) >= MIN_ART_CRITIQUE_BOX_SPAN && Math.abs(first.y - second.y) >= MIN_ART_CRITIQUE_BOX_SPAN;
  }
  if (target.type === "polygon") return polygonArea(target.points) >= MIN_ART_CRITIQUE_BOX_SPAN * MIN_ART_CRITIQUE_BOX_SPAN;
  return false;
}

export function repairIssueTarget(issue) {
  if (isRenderableArtCritiqueTarget(issue.target)) return issue;
  const target = referenceTargetForIssue(issue);
  return {
    ...issue,
    target,
    targetSource: target.type === "global" ? "global" : "reference",
  };
}

function matches(text, values) {
  return values.some((value) => text.includes(value));
}

function globalTarget() {
  return { type: "global", points: [] };
}

function referenceBox(x, y, width, height) {
  return {
    type: "box",
    points: [
      { x, y },
      { x: x + width, y: y + height },
    ],
  };
}

function referencePoints({ left, right, top, bottom }) {
  if (left && top) return { type: "points", points: [{ x: 0.18, y: 0.18 }, { x: 0.26, y: 0.3 }] };
  if (right && top) return { type: "points", points: [{ x: 0.74, y: 0.18 }, { x: 0.82, y: 0.3 }] };
  if (left && bottom) return { type: "points", points: [{ x: 0.18, y: 0.7 }, { x: 0.26, y: 0.82 }] };
  if (right && bottom) return { type: "points", points: [{ x: 0.74, y: 0.7 }, { x: 0.82, y: 0.82 }] };
  if (left && !right) return { type: "points", points: [{ x: 0.18, y: 0.25 }, { x: 0.2, y: 0.66 }] };
  if (right && !left) return { type: "points", points: [{ x: 0.76, y: 0.25 }, { x: 0.8, y: 0.66 }] };
  if (top && !bottom) return { type: "points", points: [{ x: 0.28, y: 0.18 }, { x: 0.72, y: 0.18 }] };
  if (bottom && !top) return { type: "points", points: [{ x: 0.28, y: 0.72 }, { x: 0.72, y: 0.72 }] };
  return { type: "points", points: [{ x: 0.26, y: 0.2 }, { x: 0.74, y: 0.2 }, { x: 0.52, y: 0.68 }] };
}

export function referenceTargetForIssue(issue) {
  const text = [issue.targetDescription, issue.title, issue.explanation].filter(Boolean).join(" ").toLowerCase();
  if (!text || matches(text, ["整体", "全局", "全图", "总体", "overall", "global", "whole image"])) return globalTarget();

  const left = matches(text, ["左侧", "左边", "左方", "左上", "左下", "left"]);
  const right = matches(text, ["右侧", "右边", "右方", "右上", "右下", "right"]);
  const top = matches(text, ["上方", "顶部", "上部", "上半", "天空", "top", "upper"]);
  const bottom = matches(text, ["下方", "底部", "下部", "下半", "地面", "bottom", "lower"]);
  const foreground = matches(text, ["前景", "近景", "foreground"]);
  const table = matches(text, ["桌", "台面", "台子", "桌腿", "table", "desk"]);
  const subject = matches(text, ["人物", "少女", "男孩", "女孩", "脸", "面部", "主体", "人像", "产品", "物体", "subject", "person", "face", "portrait"]);
  const head = matches(text, ["头部", "发丝", "发际", "head", "hair"]);
  const scattered = matches(text, ["多处", "多个", "多块", "散落", "分散", "亮点", "光点", "色块", "高饱和", "暖色", "反光", "highlight", "hotspot", "specular"]);

  if (table) {
    if (left && !right) return referenceBox(0.08, 0.53, 0.38, 0.38);
    if (right && !left) return referenceBox(0.54, 0.53, 0.38, 0.38);
    return referenceBox(0.16, 0.5, 0.68, 0.44);
  }
  if (foreground) {
    if (left && !right) return referenceBox(0.04, 0.05, 0.36, 0.9);
    if (right && !left) return referenceBox(0.6, 0.05, 0.36, 0.9);
    return referenceBox(0.16, 0.54, 0.68, 0.4);
  }
  if (head && matches(text, ["留白", "拥挤", "切线", "贴近", "轮廓", "装饰", "clearance"])) {
    if (left && !right) return referenceBox(0.08, 0.08, 0.34, 0.34);
    if (right && !left) return referenceBox(0.58, 0.08, 0.34, 0.34);
    return referenceBox(0.34, 0.06, 0.42, 0.36);
  }
  if (scattered) return referencePoints({ left, right, top, bottom });
  if (head) {
    if (left && !right) return referenceBox(0.08, 0.08, 0.34, 0.34);
    if (right && !left) return referenceBox(0.58, 0.08, 0.34, 0.34);
    return referenceBox(0.34, 0.06, 0.42, 0.36);
  }
  if (subject) {
    if (left && top) return referenceBox(0.06, 0.06, 0.34, 0.34);
    if (right && top) return referenceBox(0.6, 0.06, 0.34, 0.34);
    if (left && bottom) return referenceBox(0.06, 0.6, 0.34, 0.34);
    if (right && bottom) return referenceBox(0.6, 0.6, 0.34, 0.34);
    if (left && !right) return referenceBox(0.06, 0.16, 0.34, 0.68);
    if (right && !left) return referenceBox(0.6, 0.16, 0.34, 0.68);
    if (top && !bottom) return referenceBox(0.24, 0.06, 0.52, 0.34);
    if (bottom && !top) return referenceBox(0.24, 0.6, 0.52, 0.34);
    return referenceBox(0.24, 0.16, 0.52, 0.68);
  }
  if (left && top) return referenceBox(0.06, 0.06, 0.34, 0.34);
  if (right && top) return referenceBox(0.6, 0.06, 0.34, 0.34);
  if (left && bottom) return referenceBox(0.06, 0.6, 0.34, 0.34);
  if (right && bottom) return referenceBox(0.6, 0.6, 0.34, 0.34);
  if (left && !right) return referenceBox(0.06, 0.2, 0.34, 0.6);
  if (right && !left) return referenceBox(0.6, 0.2, 0.34, 0.6);
  if (top && !bottom) return referenceBox(0.24, 0.06, 0.52, 0.34);
  if (bottom && !top) return referenceBox(0.24, 0.6, 0.52, 0.34);
  return globalTarget();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function layoutArtCritiqueLabels(issues) {
  const placements = [];
  issues.forEach((issue, index) => {
    const bounds = targetBounds(issue.target);
    const preferred = {
      x: clamp(bounds.x + 0.035, 0.04, 0.96),
      y: clamp(bounds.y + 0.035, 0.04, 0.96),
    };
    let next = preferred;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const collides = placements.some((placed) => Math.abs(placed.x - next.x) < 0.095 && Math.abs(placed.y - next.y) < 0.07);
      if (!collides) break;
      next = { x: preferred.x, y: clamp(preferred.y + (attempt + 1) * 0.07, 0.04, 0.96) };
    }
    placements[index] = next;
  });
  return placements;
}
