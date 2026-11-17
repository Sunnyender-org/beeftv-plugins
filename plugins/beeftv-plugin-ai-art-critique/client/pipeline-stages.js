import { isRenderableArtCritiqueTarget, referenceTargetForIssue } from "./annotation.js";
import { findArtCritiqueRubricCheck } from "./rubrics.js";
import {
  ALL_CATEGORIES,
  ALL_IMAGE_TYPES,
  ALL_SCENE_DEPTHS,
  ALL_SEVERITIES,
  ALL_VERDICTS,
  GROUNDING_CONFIDENCE_THRESHOLD,
  MAX_CANDIDATES,
  MAX_EDIT_PROMPT_LENGTH,
  MAX_ISSUES,
  MAX_OPTIONS,
  MIN_REPORTABLE_CONFIDENCE,
  VERIFICATION_REJECTION_THRESHOLD,
} from "./pipeline-tools.js";

const isRecord = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
const numeric = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const boundedString = (v, max) => v.trim().slice(0, max);
const enumValue = (v, vals) => (typeof v === "string" && vals.includes(v) ? v : null);
const globalTarget = () => ({ type: "global", points: [] });

function boundedStrings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) throw new Error("art_critique_stage_invalid");
  return value
    .slice(0, maxItems)
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => boundedString(item, maxLength));
}

function uniqueId(value, used) {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${value}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

const candidatePriorityScore = (c) => c.severity * 0.7 + c.confidence * 0.3;
const issuePriorityScore = (i) => (i.severity === "high" ? 3 : i.severity === "medium" ? 2 : 1) * 0.7 + i.confidence * 0.3;
const prioritizeBy = (items, scoreFn) =>
  items.map((item, index) => ({ item, index })).sort((a, b) => scoreFn(b.item) - scoreFn(a.item) || a.index - b.index).map((e) => e.item);

function isReviewerAllowed(reviewer, category) {
  if (reviewer === "composition") return category === "composition";
  if (reviewer === "color") return category === "color";
  if (reviewer === "lighting") return category === "lighting";
  return category === "proportion";
}

function parseScene(value) {
  const imageType = enumValue(value.imageType, ALL_IMAGE_TYPES);
  const sceneDepth = enumValue(value.sceneDepth, ALL_SCENE_DEPTHS);
  if (!imageType || !sceneDepth || typeof value.intendedFocus !== "string" || typeof value.mood !== "string" || typeof value.estimatedIntent !== "string") {
    throw new Error("art_critique_scene_invalid");
  }
  if (!Array.isArray(value.subjects) || !Array.isArray(value.style) || !Array.isArray(value.compositionType) || !Array.isArray(value.lightingType)) {
    throw new Error("art_critique_scene_invalid");
  }
  return {
    imageType,
    style: boundedStrings(value.style, 8, 100),
    subjects: value.subjects.slice(0, 8).map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.description !== "string") throw new Error("art_critique_scene_invalid");
      const importance = enumValue(item.importance, ["primary", "secondary", "background"]);
      if (!importance) throw new Error("art_critique_scene_invalid");
      return { id: boundedString(item.id, 80), description: boundedString(item.description, 240), importance };
    }),
    intendedFocus: boundedString(value.intendedFocus, 300),
    compositionType: boundedStrings(value.compositionType, 8, 100),
    lightingType: boundedStrings(value.lightingType, 8, 100),
    mood: boundedString(value.mood, 180),
    estimatedIntent: boundedString(value.estimatedIntent, 300),
    sceneDepth,
  };
}

function parseSuggestion(value) {
  if (typeof value.goal !== "string" || typeof value.expectedEffect !== "string" || !Array.isArray(value.actions) || !Array.isArray(value.preserve)) {
    throw new Error("art_critique_aggregate_invalid");
  }
  return {
    goal: boundedString(value.goal, 500),
    actions: boundedStrings(value.actions, 6, 500),
    preserve: boundedStrings(value.preserve, 6, 500),
    expectedEffect: boundedString(value.expectedEffect, 500),
  };
}

function parseTarget(value) {
  const type = enumValue(value.type, ["box", "point", "points", "polygon", "global"]);
  if (!type || !Array.isArray(value.points)) throw new Error("art_critique_grounding_invalid");
  const points = value.points.slice(0, 12).map((point) => {
    if (!isRecord(point)) throw new Error("art_critique_grounding_invalid");
    const x = numeric(point.x);
    const y = numeric(point.y);
    if (x === null || y === null) throw new Error("art_critique_grounding_invalid");
    return { x: clamp01(x), y: clamp01(y) };
  });
  if (type === "global") return { type, points: [] };
  if ((type === "point" || type === "points") && points.length < 1) return globalTarget();
  if (type === "box" && points.length < 2) return globalTarget();
  if (type === "polygon" && points.length < 3) return globalTarget();
  return { type, points };
}

export function parseSceneRouterPayload(value) {
  if (!isRecord(value) || !isRecord(value.scene)) throw new Error("art_critique_scene_invalid");
  return { scene: parseScene(value.scene) };
}

export function parseSceneReviewPayload(value) {
  if (!isRecord(value) || !isRecord(value.scene) || !Array.isArray(value.candidates)) throw new Error("art_critique_scene_invalid");
  return { scene: parseScene(value.scene), candidates: parseCandidates(value, "composition") };
}

export function parseAggregatePayload(value) {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.strengths) || !Array.isArray(value.issues)) {
    throw new Error("art_critique_aggregate_invalid");
  }
  const ids = new Set();
  const issues = value.issues.slice(0, MAX_CANDIDATES).map((item, index) => {
    if (!isRecord(item)) throw new Error("art_critique_aggregate_invalid");
    const category = enumValue(item.category, ALL_CATEGORIES);
    const severity = enumValue(item.severity, ALL_SEVERITIES);
    const confidence = numeric(item.confidence);
    if (!category || !severity || confidence === null || typeof item.title !== "string" || typeof item.explanation !== "string" || typeof item.targetDescription !== "string" || !isRecord(item.suggestion) || !Array.isArray(item.sourceCandidateIds)) {
      throw new Error("art_critique_aggregate_invalid");
    }
    const baseId = typeof item.id === "string" && item.id.trim() ? boundedString(item.id, 80) : `issue-${index + 1}`;
    return {
      id: uniqueId(baseId, ids),
      category,
      title: boundedString(item.title, 180),
      explanation: boundedString(item.explanation, 1000),
      severity,
      confidence: clamp01(confidence),
      suggestion: parseSuggestion(item.suggestion),
      sourceCandidateIds: boundedStrings(item.sourceCandidateIds, MAX_CANDIDATES, 80),
      targetDescription: boundedString(item.targetDescription, 300),
    };
  });
  const optionIds = new Set();
  const options = (Array.isArray(value.options) ? value.options : []).slice(0, MAX_OPTIONS).map((item, index) => {
    if (!isRecord(item)) throw new Error("art_critique_aggregate_invalid");
    const category = enumValue(item.category, ALL_CATEGORIES);
    const confidence = numeric(item.confidence);
    if (!category || confidence === null || typeof item.title !== "string" || typeof item.explanation !== "string" || !isRecord(item.suggestion) || !Array.isArray(item.sourceCandidateIds)) {
      throw new Error("art_critique_aggregate_invalid");
    }
    const baseId = typeof item.id === "string" && item.id.trim() ? boundedString(item.id, 80) : `option-${index + 1}`;
    return {
      id: uniqueId(baseId, optionIds),
      category,
      title: boundedString(item.title, 180),
      explanation: boundedString(item.explanation, 1000),
      confidence: clamp01(confidence),
      suggestion: parseSuggestion(item.suggestion),
      sourceCandidateIds: boundedStrings(item.sourceCandidateIds, MAX_CANDIDATES, 80),
    };
  });
  return {
    summary: boundedString(value.summary, 1600),
    strengths: boundedStrings(value.strengths, 8, 500),
    issues: prioritizeBy(issues, issuePriorityScore).slice(0, MAX_ISSUES),
    options: [...options].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_OPTIONS),
  };
}

export function parseGroundingPayload(value) {
  if (!isRecord(value) || !Array.isArray(value.targets)) throw new Error("art_critique_grounding_invalid");
  return {
    targets: value.targets.slice(0, MAX_ISSUES).map((item) => {
      if (!isRecord(item) || typeof item.issueId !== "string" || !isRecord(item.target)) throw new Error("art_critique_grounding_invalid");
      const groundingConfidence = numeric(item.groundingConfidence);
      if (groundingConfidence === null) throw new Error("art_critique_grounding_invalid");
      return { issueId: boundedString(item.issueId, 80), target: parseTarget(item.target), groundingConfidence: clamp01(groundingConfidence) };
    }),
  };
}

export function parseVerificationPayload(value) {
  if (!isRecord(value) || !Array.isArray(value.decisions)) throw new Error("art_critique_verification_invalid");
  return {
    decisions: value.decisions.slice(0, MAX_ISSUES).map((item) => {
      if (!isRecord(item) || typeof item.issueId !== "string" || typeof item.reason !== "string") throw new Error("art_critique_verification_invalid");
      const verdict = enumValue(item.verdict, ALL_VERDICTS);
      const confidence = numeric(item.confidence);
      if (!verdict || confidence === null) throw new Error("art_critique_verification_invalid");
      return {
        issueId: boundedString(item.issueId, 80),
        verification: { verdict, confidence: clamp01(confidence), reason: boundedString(item.reason, 500) },
      };
    }),
  };
}

export function parseEditPromptPayload(value) {
  if (!isRecord(value) || !Array.isArray(value.prompts)) throw new Error("art_critique_edit_prompt_invalid");
  return {
    prompts: value.prompts.slice(0, MAX_ISSUES).map((item) => {
      if (!isRecord(item) || typeof item.issueId !== "string" || !item.issueId.trim() || typeof item.editPrompt !== "string" || !item.editPrompt.trim()) {
        throw new Error("art_critique_edit_prompt_invalid");
      }
      return { issueId: boundedString(item.issueId, 80), editPrompt: boundedString(item.editPrompt, MAX_EDIT_PROMPT_LENGTH) };
    }),
  };
}

export function applyGrounding(issues, targets) {
  const targetByIssue = new Map(targets.map((target) => [target.issueId, target]));
  return issues.map((issue) => {
    const grounded = targetByIssue.get(issue.id);
    if (!grounded) return { ...issue, target: globalTarget(), targetSource: "global" };
    const reliable = grounded.target.type !== "global" && grounded.groundingConfidence >= GROUNDING_CONFIDENCE_THRESHOLD && isRenderableArtCritiqueTarget(grounded.target);
    if (!reliable && grounded.target.type !== "global") {
      const target = referenceTargetForIssue(issue);
      return { ...issue, target, targetSource: target.type === "global" ? "global" : "reference", groundingConfidence: grounded.groundingConfidence };
    }
    return { ...issue, target: reliable ? grounded.target : globalTarget(), targetSource: reliable ? "model" : "global", groundingConfidence: grounded.groundingConfidence };
  });
}

export function applyReferenceCoordinates(issues) {
  return issues.map((issue) => {
    const target = referenceTargetForIssue(issue);
    return { ...issue, target, targetSource: target.type === "global" ? "global" : "reference" };
  });
}

export function applyVerification(issues, decisions) {
  const issueIds = new Set(issues.map((issue) => issue.id));
  const relevant = decisions.filter((decision) => issueIds.has(decision.issueId));
  const decisionByIssue = new Map(relevant.map((decision) => [decision.issueId, decision.verification]));
  const annotated = issues.map((issue) => {
    const verification = decisionByIssue.get(issue.id);
    return verification ? { ...issue, verification } : issue;
  });
  const kept = annotated.filter((issue) => issue.verification?.verdict !== "rejected" || issue.verification.confidence < VERIFICATION_REJECTION_THRESHOLD);
  const summary = relevant.reduce(
    (result, decision) => {
      result.checked += 1;
      result[decision.verification.verdict] += 1;
      return result;
    },
    { checked: 0, confirmed: 0, uncertain: 0, rejected: 0 },
  );
  return { issues: kept, summary };
}

export function applyEditPrompts(issues, prompts, warnings = []) {
  const promptByIssue = new Map(prompts.map((prompt) => [prompt.issueId, prompt.editPrompt]));
  const missingCount = issues.filter((issue) => !promptByIssue.has(issue.id)).length;
  if (missingCount) warnings.push(`AI 修改提示词未覆盖 ${missingCount} 个问题，缺失项不会使用本地拼接替代。`);
  return issues.map((issue) => {
    const editPrompt = promptByIssue.get(issue.id);
    return editPrompt ? { ...issue, editPrompt } : issue;
  });
}

export function parseCandidates(value, reviewer) {
  if (!isRecord(value) || !Array.isArray(value.candidates)) throw new Error("art_critique_candidates_invalid");
  const ids = new Set();
  return value.candidates.slice(0, MAX_CANDIDATES).flatMap((item, index) => {
    if (!isRecord(item)) throw new Error("art_critique_candidates_invalid");
    const category = enumValue(item.category, ALL_CATEGORIES);
    const severity = numeric(item.severity);
    const confidence = numeric(item.confidence);
    if (!category || severity === null || confidence === null || typeof item.title !== "string" || typeof item.observation !== "string" || typeof item.reason !== "string" || typeof item.targetDescription !== "string") {
      throw new Error("art_critique_candidates_invalid");
    }
    const checkId = typeof item.checkId === "string" ? boundedString(item.checkId, 80) : "";
    const kind = enumValue(item.kind, ["issue", "option"]) || "issue";
    const evidence = Array.isArray(item.evidence) ? boundedStrings(item.evidence, 4, 300) : [];
    const rule = findArtCritiqueRubricCheck(checkId);
    const title = boundedString(item.title, 180);
    const observation = boundedString(item.observation, 600);
    const reason = boundedString(item.reason, 800);
    const targetDescription = boundedString(item.targetDescription, 300);
    if (!rule || rule.category !== category || !isReviewerAllowed(reviewer, category) || !title || !observation || !reason || !targetDescription || (rule.evidenceRequired !== false && evidence.length === 0) || clamp01(confidence) < Math.max(rule.minConfidence ?? 0.55, MIN_REPORTABLE_CONFIDENCE)) {
      return [];
    }
    const requestedId = typeof item.id === "string" && item.id.trim() ? boundedString(item.id, 80) : `candidate-${index + 1}`;
    return [{ id: uniqueId(requestedId, ids), checkId, kind, category, title, observation, reason, evidence, severity: clamp01(severity), confidence: clamp01(confidence), targetDescription, reviewer }];
  });
}

export function cleanAggregate(scene) {
  const focus = scene.intendedFocus === "未确定" ? "画面" : scene.intendedFocus;
  return { summary: `已完成对${focus}的多维检查，本轮未发现需要优先修改的可靠问题。`, strengths: [], issues: [], options: [] };
}

export function filterAggregateAgainstCandidates(aggregate, candidates, warnings) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = aggregate.issues.filter((issue) => {
    const sourceIds = issue.sourceCandidateIds || [];
    if (!sourceIds.length || sourceIds.some((id) => !candidateById.has(id))) return false;
    const sources = sourceIds.map((id) => candidateById.get(id)).filter(Boolean);
    return sources.length > 0 && sources.every((c) => c.kind === "issue" && c.category === issue.category) && issue.confidence >= MIN_REPORTABLE_CONFIDENCE;
  });
  const acceptedOptions = aggregate.options.filter((option) => {
    const sourceIds = option.sourceCandidateIds || [];
    if (!sourceIds.length || sourceIds.some((id) => !candidateById.has(id))) return false;
    const sources = sourceIds.map((id) => candidateById.get(id)).filter(Boolean);
    return sources.length > 0 && sources.every((c) => c.kind === "option" && c.category === option.category) && option.confidence >= MIN_REPORTABLE_CONFIDENCE;
  });
  if (accepted.length !== aggregate.issues.length || acceptedOptions.length !== aggregate.options.length) {
    warnings.push(`聚合阶段返回了 ${aggregate.issues.length - accepted.length + aggregate.options.length - acceptedOptions.length} 个无可靠来源或低置信度结果，已过滤。`);
  }
  const deduplicated = deduplicateAggregateIssues(accepted, warnings);
  return {
    ...aggregate,
    issues: prioritizeBy(deduplicated, issuePriorityScore).slice(0, MAX_ISSUES),
    options: [...acceptedOptions].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_OPTIONS),
  };
}

function issueTopicKey(issue) {
  const text = `${issue.title} ${issue.explanation} ${issue.targetDescription}`.toLowerCase();
  const has = (values) => values.some((value) => text.includes(value));
  if (has(["主体", "人物", "女性", "脸", "面部", "人像", "subject", "person", "face"]) && has(["受光", "暗部", "阴影", "亮度", "曝光", "轮廓光", "分离", "融入背景", "冷影", "lighting", "shadow"])) return "subject-lighting";
  if (has(["前景", "近景", "背影", "foreground"]) && has(["焦点", "动线", "注意力", "视觉阅读", "视觉重量", "压过", "抢走", "focus", "attention"])) return "foreground-focus";
  if (has(["高饱和", "饱和度", "亮点", "光点", "霓虹", "色彩焦点", "saturation", "highlight", "hotspot"]) && has(["焦点", "动线", "注意力", "视觉阅读", "视觉重量", "压过", "抢走", "focus", "attention"])) return "saturated-focus";
  if (has(["主体", "人物", "女性", "脸", "面部", "人像", "subject", "person", "face"]) && has(["留白", "拥挤", "切线", "裁切", "边缘", "间距", "轮廓贴近", "negative space", "crop"])) return "subject-space";
  return null;
}

function mergeDistinctText(primary, secondary, maxLength) {
  if (!secondary || primary.includes(secondary)) return primary.slice(0, maxLength);
  if (!primary || secondary.includes(primary)) return secondary.slice(0, maxLength);
  return `${primary}；${secondary}`.slice(0, maxLength);
}

const uniqueStrings = (values) => [...new Set(values.filter((value) => value.trim().length > 0))];

export function deduplicateAggregateIssues(issues, warnings) {
  const merged = [];
  let mergedCount = 0;
  for (const issue of issues) {
    const existingIndex = merged.findIndex((candidate) => {
      if (candidate.category !== issue.category) return false;
      const rightSourceIds = new Set(issue.sourceCandidateIds || []);
      if ((candidate.sourceCandidateIds || []).some((id) => rightSourceIds.has(id))) return true;
      const leftTopic = issueTopicKey(candidate);
      return leftTopic !== null && leftTopic === issueTopicKey(issue);
    });
    if (existingIndex < 0) {
      merged.push(issue);
      continue;
    }
    const left = merged[existingIndex];
    const primary = issuePriorityScore(left) >= issuePriorityScore(issue) ? left : issue;
    const secondary = primary === left ? issue : left;
    merged[existingIndex] = {
      ...primary,
      explanation: mergeDistinctText(primary.explanation, secondary.explanation, 1000),
      confidence: Math.max(primary.confidence, secondary.confidence),
      targetDescription: mergeDistinctText(primary.targetDescription, secondary.targetDescription, 300),
      sourceCandidateIds: uniqueStrings([...(primary.sourceCandidateIds || []), ...(secondary.sourceCandidateIds || [])]).slice(0, MAX_CANDIDATES),
      suggestion: {
        ...primary.suggestion,
        actions: uniqueStrings([...primary.suggestion.actions, ...secondary.suggestion.actions]).slice(0, 6),
        preserve: uniqueStrings([...primary.suggestion.preserve, ...secondary.suggestion.preserve]).slice(0, 6),
      },
    };
    mergedCount += 1;
  }
  if (mergedCount && warnings) warnings.push(`聚合阶段合并了 ${mergedCount} 个重复或同根因问题。`);
  return merged;
}

export function fallbackAggregate(scene, candidates, warnings) {
  const severityFromScore = (v) => (v >= 0.75 ? "high" : v >= 0.45 ? "medium" : "low");
  const issueDrafts = candidates
    .filter((c) => c.kind === "issue")
    .map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      explanation: `${c.observation}${c.reason ? ` ${c.reason}` : ""}`,
      severity: severityFromScore(c.severity),
      confidence: c.confidence,
      targetDescription: c.targetDescription,
      sourceCandidateIds: [c.id],
      suggestion: {
        goal: `降低“${c.title}”对画面表达的影响`,
        actions: [`围绕${c.targetDescription || "问题区域"}进行针对性调整，并先保留当前主体和画面意图。`],
        preserve: ["保留当前画面的主体意图"],
        expectedEffect: "问题对视觉层级和画面表达的干扰减弱。",
      },
    }));
  const selectedIssues = prioritizeBy(deduplicateAggregateIssues(issueDrafts, warnings), issuePriorityScore).slice(0, MAX_ISSUES);
  const selectedOptions = prioritizeBy(candidates.filter((c) => c.kind === "option"), candidatePriorityScore).slice(0, MAX_OPTIONS);
  const focus = scene.intendedFocus === "未确定" ? "画面" : scene.intendedFocus;
  return {
    summary: selectedIssues.length
      ? `已完成对${focus}的多维度检查，以下是当前最值得优先处理的问题。`
      : selectedOptions.length
        ? `已完成对${focus}的多维度检查，未发现需要优先修改的可靠问题；下面是可选的风格方向。`
        : "已完成场景检查，但没有识别到足够可靠的重点问题。",
    strengths: [],
    issues: selectedIssues,
    options: selectedOptions.map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      explanation: `${c.observation}${c.reason ? ` ${c.reason}` : ""}`,
      confidence: c.confidence,
      sourceCandidateIds: [c.id],
      suggestion: {
        goal: `如果希望强化“${c.title}”所代表的方向，可以尝试以下调整`,
        actions: [`围绕${c.targetDescription || "相关区域"}进行小幅尝试，比较调整前后的表达差异。`],
        preserve: ["保留当前画面的主体意图"],
        expectedEffect: "画面更接近该风格方向，但这不是对原图的错误判定。",
      },
    })),
  };
}

export function filterCandidatesForScene(candidates, imageType) {
  return candidates.filter((candidate) => {
    const rule = findArtCritiqueRubricCheck(candidate.checkId);
    return Boolean(rule && (rule.applicableImageTypes || ALL_IMAGE_TYPES).includes(imageType));
  });
}

export function reviewerLabel(reviewer) {
  if (reviewer === "composition") return "构图与叙事";
  if (reviewer === "color") return "色彩";
  if (reviewer === "lighting") return "光线";
  return "结构与比例";
}

export function appendCandidates(existing, incoming) {
  const used = new Set(existing.map((candidate) => candidate.id));
  return [...existing, ...incoming.map((candidate) => ({ ...candidate, id: uniqueId(candidate.id, used) }))];
}

export const toIssueDraft = (issue) => ({
  id: issue.id,
  category: issue.category,
  title: issue.title,
  explanation: issue.explanation,
  severity: issue.severity,
  confidence: issue.confidence,
  target: globalTarget(),
  targetDescription: issue.targetDescription,
  targetSource: "global",
  suggestion: issue.suggestion,
  sourceCandidateIds: issue.sourceCandidateIds,
});

export const toOptionDraft = (option) => ({
  id: option.id,
  category: option.category,
  title: option.title,
  explanation: option.explanation,
  confidence: option.confidence,
  suggestion: option.suggestion,
  sourceCandidateIds: option.sourceCandidateIds,
});

export const createEmptyScene = () => ({
  imageType: "other",
  style: [],
  subjects: [],
  intendedFocus: "未确定",
  compositionType: [],
  lightingType: [],
  mood: "未确定",
  estimatedIntent: "未确定",
  sceneDepth: "medium",
});
