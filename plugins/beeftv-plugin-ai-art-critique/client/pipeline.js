import {
  ART_CRITIQUE_RUBRIC_VERSION,
  ART_CRITIQUE_SCHEMA_VERSION,
  artCritiqueSourceFingerprint,
  isArtCritiqueImageInput,
} from "./contracts.js";
import {
  appendCandidates,
  applyEditPrompts,
  applyGrounding,
  applyReferenceCoordinates,
  applyVerification,
  cleanAggregate,
  createEmptyScene,
  deduplicateAggregateIssues,
  fallbackAggregate,
  filterAggregateAgainstCandidates,
  filterCandidatesForScene,
  parseAggregatePayload,
  parseCandidates,
  parseEditPromptPayload,
  parseGroundingPayload,
  parseSceneReviewPayload,
  parseSceneRouterPayload,
  parseVerificationPayload,
  reviewerLabel,
  toIssueDraft,
  toOptionDraft,
} from "./pipeline-stages.js";
import {
  aggregateMessages,
  artCritiquePipelineTools,
  colorMessages,
  compositionMessages,
  editPromptMessages,
  groundingMessages,
  lightingMessages,
  requestPipelineStage,
  rethrowIfAborted,
  sceneMessages,
  structureMessages,
  throwIfAborted,
  verificationMessages,
} from "./pipeline-tools.js";

export {
  artCritiquePipelineTools,
  applyEditPrompts,
  applyGrounding,
  applyReferenceCoordinates,
  applyVerification,
  deduplicateAggregateIssues,
  filterAggregateAgainstCandidates,
  parseAggregatePayload,
  parseEditPromptPayload,
  parseGroundingPayload,
  parseSceneReviewPayload,
  parseSceneRouterPayload,
  parseVerificationPayload,
};

export const ART_CRITIQUE_MAX_MODEL_CALLS = 9;

function emitStage(options, stage) {
  throwIfAborted(options.signal);
  options.onStage?.(stage);
}

export async function runArtCritiquePipeline(host, input, options = {}) {
  const model = options.model ?? host?.ai?.getTextModelConfig?.()?.model?.trim() ?? "";
  if (!model) throw new Error("未配置文本/视觉理解模型，请先在设置中选择支持图片理解的文本模型");
  const stageOptions = { ...options, model };
  const warnings = [];
  const fallbackScene = createEmptyScene();
  let scene = fallbackScene;
  let candidates = [];
  let verificationSummary;
  let reviewerSucceeded = 0;

  emitStage(stageOptions, "scene");
  const sceneRequest = requestPipelineStage(
    host,
    sceneMessages(input),
    artCritiquePipelineTools.scene,
    "analyze_art_scene",
    parseSceneRouterPayload,
    stageOptions,
  ).then(
    (result) => ({ ok: true, scene: result.scene }),
    (error) => ({ ok: false, error }),
  );

  const runReviewer = (reviewer, messages, tool, toolName) =>
    requestPipelineStage(host, messages, tool, toolName, (value) => ({ candidates: parseCandidates(value, reviewer) }), stageOptions);

  emitStage(stageOptions, "reviewing");
  const reviewerSpecs = [
    { reviewer: "composition", messages: compositionMessages(input, fallbackScene), tool: artCritiquePipelineTools.composition, toolName: "review_art_composition" },
    { reviewer: "color", messages: colorMessages(input, fallbackScene), tool: artCritiquePipelineTools.color, toolName: "review_art_color" },
    { reviewer: "lighting", messages: lightingMessages(input, fallbackScene), tool: artCritiquePipelineTools.lighting, toolName: "review_art_lighting" },
    { reviewer: "structure", messages: structureMessages(input, fallbackScene), tool: artCritiquePipelineTools.structure, toolName: "review_art_structure" },
  ];
  const reviewerResultsRequest = Promise.allSettled(
    reviewerSpecs.map(({ reviewer, messages, tool, toolName }) => runReviewer(reviewer, messages, tool, toolName)),
  );
  const [sceneOutcome, reviewerResults] = await Promise.all([sceneRequest, reviewerResultsRequest]);

  if (sceneOutcome.ok) {
    scene = sceneOutcome.scene;
  } else {
    rethrowIfAborted(sceneOutcome.error, stageOptions.signal);
    warnings.push("场景理解阶段未完成，后续步骤使用了默认场景上下文。");
  }

  reviewerResults.forEach((result, index) => {
    const reviewer = reviewerSpecs[index].reviewer;
    if (result.status === "fulfilled") {
      reviewerSucceeded += 1;
      candidates = appendCandidates(candidates, filterCandidatesForScene(result.value.candidates, scene.imageType));
      return;
    }
    rethrowIfAborted(result.reason, stageOptions.signal);
    warnings.push(`${reviewerLabel(reviewer)} Reviewer 未完成，已使用其他通道继续。`);
  });

  if (!reviewerSucceeded) throw new Error("art_critique_pipeline_failed");

  emitStage(stageOptions, "aggregating");
  let aggregate = cleanAggregate(scene);
  if (candidates.length) {
    try {
      const parsed = await requestPipelineStage(
        host,
        aggregateMessages(input, scene, candidates),
        artCritiquePipelineTools.aggregate,
        "aggregate_art_critique",
        parseAggregatePayload,
        stageOptions,
      );
      aggregate = filterAggregateAgainstCandidates(parsed, candidates, warnings);
    } catch (error) {
      rethrowIfAborted(error, stageOptions.signal);
      warnings.push("问题聚合阶段未完成，已使用本地规则整理候选问题。");
      aggregate = fallbackAggregate(scene, candidates, warnings);
    }
  }

  let issues = aggregate.issues.map(toIssueDraft);
  const reportOptions = aggregate.options.map(toOptionDraft);
  const buildReport = () => ({
    schemaVersion: ART_CRITIQUE_SCHEMA_VERSION,
    rubricVersion: ART_CRITIQUE_RUBRIC_VERSION,
    summary: aggregate.summary,
    strengths: aggregate.strengths,
    issues,
    ...(reportOptions.length ? { options: reportOptions } : {}),
    sourceFingerprint: input.sourceFingerprint,
    createdAt: new Date().toISOString(),
    scene,
    ...(warnings.length ? { pipelineWarnings: warnings } : {}),
    ...(verificationSummary ? { verificationSummary } : {}),
  });

  if (issues.length) {
    emitStage(stageOptions, "grounding");
    stageOptions.onDraftReport?.(buildReport());
    try {
      const grounding = await requestPipelineStage(
        host,
        groundingMessages(input, scene, issues),
        artCritiquePipelineTools.grounding,
        "ground_art_critique_issues",
        parseGroundingPayload,
        stageOptions,
      );
      issues = applyGrounding(issues, grounding.targets);
    } catch (error) {
      rethrowIfAborted(error, stageOptions.signal);
      warnings.push("问题定位阶段未完成，已根据问题描述使用参考区域坐标；坐标仅作辅助参考，文字报告仍然保留。");
      issues = applyReferenceCoordinates(issues);
    }

    emitStage(stageOptions, "verifying");
    const verificationRequest = requestPipelineStage(
      host,
      verificationMessages(input, scene, issues),
      artCritiquePipelineTools.verification,
      "verify_art_critique",
      parseVerificationPayload,
      stageOptions,
    );
    const promptRequest = requestPipelineStage(
      host,
      editPromptMessages(input, scene, issues),
      artCritiquePipelineTools.promptWriter,
      "generate_art_edit_prompts",
      parseEditPromptPayload,
      stageOptions,
    );
    const [verificationResult, promptResult] = await Promise.allSettled([verificationRequest, promptRequest]);

    if (verificationResult.status === "fulfilled") {
      const verified = applyVerification(issues, verificationResult.value.decisions);
      issues = verified.issues;
      verificationSummary = verified.summary;
      if (!issues.length) {
        warnings.push("独立复核未确认重点问题，已过滤不可靠的批改项。");
        aggregate = { ...aggregate, summary: "独立复核后未确认需要优先修改的问题。" };
      }
    } else {
      rethrowIfAborted(verificationResult.reason, stageOptions.signal);
      warnings.push("独立复核阶段未完成，已保留聚合后的批改结果。");
    }

    if (promptResult.status === "fulfilled") {
      issues = applyEditPrompts(issues, promptResult.value.prompts, warnings);
    } else {
      rethrowIfAborted(promptResult.reason, stageOptions.signal);
      warnings.push("AI 修改提示词阶段未完成，报告仍保留问题和定位结果；请重新批改后再复制提示词。");
    }
  } else {
    stageOptions.onDraftReport?.(buildReport());
  }

  emitStage(stageOptions, "annotating");
  return buildReport();
}

export async function executeArtCritique(host, input) {
  if (!input?.nodeId || !input?.runId || !isArtCritiqueImageInput(input.source)) {
    throw new Error("分析需要真实目标节点、执行标识和已有图片");
  }
  const scope = host.utils?.getActiveUserScope?.() || "";
  const assertLive = () => {
    const currentScope = host.utils?.getActiveUserScope?.() || "";
    if (input.signal?.aborted || currentScope !== scope) {
      throw new DOMException("分析已停止或账号已切换", "AbortError");
    }
  };
  assertLive();
  const content = input.source.metadata?.content || input.source.metadata?.previewContent || "";
  const image = await host.media.inspectImage(
    {
      storageKey: input.source.metadata?.storageKey,
      ...(content.startsWith("data:") ? { dataUrl: content } : { url: content }),
      name: input.source.title,
    },
    "original",
  );
  assertLive();
  const calledStages = new Set();
  const runner = input.runner;
  const model = input.model ?? host.ai?.getTextModelConfig?.()?.model?.trim() ?? "";

  return runArtCritiquePipeline(
    host,
    {
      dataUrl: image.storageKey,
      title: input.source.title,
      sourceFingerprint: artCritiqueSourceFingerprint(input.source),
    },
    {
      model,
      signal: input.signal,
      onStage: (stage) => {
        assertLive();
        input.onStage?.(stage);
      },
      onDraftReport: (report) => {
        assertLive();
        input.onDraftReport?.(report);
      },
      requestStage: async ({ messages, tool, toolName, signal }) => {
        assertLive();
        if (calledStages.has(toolName) || calledStages.size >= ART_CRITIQUE_MAX_MODEL_CALLS) {
          throw new Error("分析阶段重复或超过本次调用数量上限");
        }
        calledStages.add(toolName);
        return runner.execute({
          model,
          messages,
          tools: [tool],
          toolChoice: { type: "function", name: toolName },
          prompt: `图片审美分析：${toolName}`,
          signal,
          metadata: { source: "art-critique", nodeId: input.nodeId, runId: input.runId, stage: toolName },
          onTaskCreated: (task) => {
            if ((host.utils?.getActiveUserScope?.() || "") === scope) {
              input.onTaskCreated?.(toolName, task.id);
            }
          },
        });
      },
    },
  );
}
