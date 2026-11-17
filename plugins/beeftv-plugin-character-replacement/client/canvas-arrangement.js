import {
  buildCharacterReplacementPackage,
  buildTimelineRangeReplacement,
  normalizeGenderHint,
  normalizePosition,
  normalizePromptMode,
  normalizeReplacementScope,
  uniqueNodeTitle,
} from "./compiler.js";

let lastKnownCanvasId = "";

export function rememberCanvasId(host, canvasId) {
  const clean = String(canvasId || "").trim();
  if (!clean || clean === "[object Promise]") return;
  lastKnownCanvasId = clean;
  host?.storage?.set?.("lastCanvasId", clean);
}

export function resolveActiveCanvasId(host, explicitCanvasId) {
  const explicit = String(explicitCanvasId || "").trim();
  if (explicit && explicit !== "[object Promise]") return explicit;
  const fromContext = String(host?.context?.getCanvasId?.() || "").trim();
  if (fromContext && fromContext !== "[object Promise]") {
    rememberCanvasId(host, fromContext);
    return fromContext;
  }
  if (typeof host?.storage?.get === "function") {
    const rawStorage = host.storage.get("lastCanvasId");
    if (typeof rawStorage === "string") {
      const clean = rawStorage.trim();
      if (clean && clean !== "[object Promise]") {
        lastKnownCanvasId = clean;
        return clean;
      }
    }
    return "";
  }
  return lastKnownCanvasId;
}

export async function resolveActiveCanvasIdAsync(host, explicitCanvasId) {
  const syncId = resolveActiveCanvasId(host, explicitCanvasId);
  if (syncId) return syncId;
  try {
    const stored = await host?.storage?.get?.("lastCanvasId");
    if (typeof stored === "string") {
      const clean = stored.trim();
      if (clean && clean !== "[object Promise]") {
        lastKnownCanvasId = clean;
        return clean;
      }
    }
  } catch {
    // ignore storage read error
  }
  return "";
}

async function createInitialCanvasDocument(host, canvasId, title) {
  const now = new Date().toISOString();
  const doc = {
    id: canvasId,
    title,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 120, y: 120, zoom: 1 },
    directorScenes: [],
  };
  return host.ops.call("canvas.document.commit", {
    canvasId,
    expectedRevision: 0,
    document: doc,
  });
}

export async function arrangeCharacterReplacementOnCanvas(host, config = {}) {
  let sourceKeyframeNodeId = String(config.sourceKeyframeNodeId || "").trim();
  let targetCharacterNodeId = String(config.targetCharacterNodeId || "").trim();
  let locationGuideNodeId = String(config.locationGuideNodeId || "").trim();
  let sourceVideoNodeId = String(config.sourceVideoNodeId || "").trim();
  let controlNodeId = String(config.controlNodeId || "").trim();

  const missingReferences = [];
  if (!sourceKeyframeNodeId) missingReferences.push("sourceKeyframeNodeId（原关键帧图节点）");
  if (!targetCharacterNodeId) missingReferences.push("targetCharacterNodeId（目标角色参考图节点）");
  if (!sourceVideoNodeId) missingReferences.push("sourceVideoNodeId（原镜头视频节点）");
  if (config.requireReferences && missingReferences.length > 0) {
    throw new Error(`缺少必需的上游参考节点：${missingReferences.join("、")}`);
  }

  const shotTitle = String(config.shotTitle || "镜头 1").trim() || "镜头 1";
  let canvasId = await resolveActiveCanvasIdAsync(host, config.canvasId);
  if (!canvasId && config.autoCreateCanvas) {
    canvasId = `canvas-char-${Date.now().toString(36)}`;
    await createInitialCanvasDocument(host, canvasId, `${shotTitle} · AI 角色替换画布`);
  }
  if (!canvasId) {
    throw new Error("请先打开一个画布或在替换工作室填写目标画布 ID 后再执行角色替换编排");
  }
  rememberCanvasId(host, canvasId);

  let snap;
  try {
    snap = await host.ops.call("canvas.get", { canvasId });
  } catch (err) {
    if (config.autoCreateCanvas) {
      await createInitialCanvasDocument(host, canvasId, `${shotTitle} · AI 角色替换画布`);
      snap = await host.ops.call("canvas.get", { canvasId });
    } else {
      throw err;
    }
  }
  const snapRevision = Number(snap?.revision ?? snap?.canvas?.revision);
  let revision = Number.isSafeInteger(config.expectedRevision) && config.expectedRevision >= 0
    ? config.expectedRevision
    : Number.isSafeInteger(snapRevision) && snapRevision >= 0
      ? snapRevision
      : 1;
  const existingNodes = Array.isArray(snap?.nodes)
    ? snap.nodes
    : Array.isArray(snap?.canvas?.nodes)
      ? snap.canvas.nodes
      : [];
  const existingTitles = new Set(
    existingNodes
      .map((item) => String(item?.title || "").trim())
      .filter(Boolean),
  );

  if (config.autoCreateInputNodes) {
    const inputDrafts = [];
    const inputSlotOrder = [];
    if (!sourceKeyframeNodeId) {
      inputSlotOrder.push("sourceKeyframe");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 原视频关键帧（图1）`, existingTitles),
        type: "image",
        prompt: `原视频被替换人物关键帧：${String(config.sourceDescription || "原镜头人物").trim()}`,
      });
    }
    if (!targetCharacterNodeId) {
      inputSlotOrder.push("targetCharacter");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 目标角色参考图（图2）`, existingTitles),
        type: "image",
        prompt: `目标替换角色正面清晰参考图：${String(config.targetDescription || "目标角色").trim()}`,
      });
    }
    if (config.promptMode === "positioning" && !locationGuideNodeId) {
      inputSlotOrder.push("locationGuide");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 人物框选定位图（图3）`, existingTitles),
        type: "image",
        prompt: "多人场景人物红框定位辅助图（A框标识待替换人物区域）",
      });
    }
    if (!sourceVideoNodeId) {
      inputSlotOrder.push("sourceVideo");
      inputDrafts.push({
        title: uniqueNodeTitle(`${shotTitle} · 原镜头视频（视频1）`, existingTitles),
        type: "video",
        prompt: `原镜头待替换视频片段：${String(config.sourceDescription || "原镜头人物动作与运镜").trim()}`,
      });
    }
    if (inputDrafts.length > 0) {
      const createdInputs = await host.ops.call("canvas.nodes.create", {
        canvasId,
        expectedRevision: revision,
        nodes: inputDrafts,
      });
      revision = Number(createdInputs?.revision ?? revision + 1);
      const createdInputList = Array.isArray(createdInputs?.created) ? createdInputs.created : [];
      inputSlotOrder.forEach((slot, idx) => {
        const createdId = createdInputList[idx]?.id || "";
        if (!createdId) return;
        if (slot === "sourceKeyframe") sourceKeyframeNodeId = createdId;
        if (slot === "targetCharacter") targetCharacterNodeId = createdId;
        if (slot === "locationGuide") locationGuideNodeId = createdId;
        if (slot === "sourceVideo") sourceVideoNodeId = createdId;
      });
      missingReferences.length = 0;
      if (!sourceKeyframeNodeId) missingReferences.push("sourceKeyframeNodeId（原关键帧图节点）");
      if (!targetCharacterNodeId) missingReferences.push("targetCharacterNodeId（目标角色参考图节点）");
      if (!sourceVideoNodeId) missingReferences.push("sourceVideoNodeId（原镜头视频节点）");
    }
  }

  const hasLocationGuideImage =
    config.hasLocationGuideImage !== undefined
      ? Boolean(config.hasLocationGuideImage)
      : Boolean(locationGuideNodeId);
  const compiled = buildCharacterReplacementPackage({
    ...config,
    hasLocationGuideImage,
  });
  const shouldCreateControlNode = Boolean(config.createControlNode) && !controlNodeId;
  const controlTitle = shouldCreateControlNode
    ? uniqueNodeTitle(`${shotTitle} · 角色替换配置`, existingTitles)
    : "";
  const keyframeTitle = uniqueNodeTitle(`${shotTitle} · 关键帧换人`, existingTitles);
  const videoTitle = uniqueNodeTitle(`${shotTitle} · 视频角色替换`, existingTitles);

  const stageNodes = [];
  if (shouldCreateControlNode) {
    const normalizedPos = normalizePosition(config.position || "single");
    const normalizedGender = normalizeGenderHint(config.genderHint || "person");
    const normalizedScope = normalizeReplacementScope(config.replacementScope || "full-person");
    const normalizedMode = normalizePromptMode(config.promptMode || "regular");
    const srcDesc = String(config.sourceDescription || "").trim();
    const tgtDesc = String(config.targetDescription || "").trim();
    stageNodes.push({
      type: "character-replacement",
      title: controlTitle,
      prompt: `镜头：${shotTitle}\n原人物：${srcDesc || normalizedPos}\n目标角色：${tgtDesc}\n范围：${normalizedScope}`,
      pluginData: {
        shotTitle,
        position: normalizedPos,
        genderHint: normalizedGender,
        sourceDescription: srcDesc,
        targetDescription: tgtDesc,
        replacementScope: normalizedScope,
        promptMode: normalizedMode,
        manualPrompt: String(config.manualPrompt || "").trim(),
        sourceKeyframeNodeId,
        targetCharacterNodeId,
        locationGuideNodeId,
        sourceVideoNodeId,
      },
    });
  }
  stageNodes.push(
    {
      title: keyframeTitle,
      type: "image",
      prompt: compiled.prompt,
    },
    {
      title: videoTitle,
      type: "video",
      prompt: compiled.videoPrompt,
    },
  );

  const created = await host.ops.call("canvas.nodes.create", {
    canvasId,
    expectedRevision: revision,
    nodes: stageNodes,
  });
  revision = Number(created?.revision ?? revision + 1);
  const createdList = Array.isArray(created?.created) ? created.created : [];
  if (shouldCreateControlNode) {
    controlNodeId = createdList[0]?.id || "";
  }
  const offset = shouldCreateControlNode ? 1 : 0;
  const keyframeNodeId = createdList[offset]?.id || "";
  const videoNodeId = createdList[offset + 1]?.id || "";

  if (videoNodeId) {
    const configured = await host.ops.call("canvas.node.configure", {
      canvasId,
      nodeId: videoNodeId,
      kind: "video",
      expectedRevision: revision,
      patch: {
        videoEditOperation: "replace_element",
      },
    });
    revision = Number(configured?.revision ?? revision + 1);
  }

  const edgesToCreate = [];

  if (sourceKeyframeNodeId && keyframeNodeId) {
    edgesToCreate.push([sourceKeyframeNodeId, keyframeNodeId]);
  }
  if (targetCharacterNodeId && keyframeNodeId && targetCharacterNodeId !== sourceKeyframeNodeId) {
    edgesToCreate.push([targetCharacterNodeId, keyframeNodeId]);
  }
  if (
    locationGuideNodeId &&
    keyframeNodeId &&
    locationGuideNodeId !== sourceKeyframeNodeId &&
    locationGuideNodeId !== targetCharacterNodeId
  ) {
    edgesToCreate.push([locationGuideNodeId, keyframeNodeId]);
  }
  if (
    controlNodeId &&
    keyframeNodeId &&
    controlNodeId !== sourceKeyframeNodeId &&
    controlNodeId !== targetCharacterNodeId &&
    controlNodeId !== locationGuideNodeId
  ) {
    edgesToCreate.push([controlNodeId, keyframeNodeId]);
  }
  if (sourceVideoNodeId && videoNodeId) {
    edgesToCreate.push([sourceVideoNodeId, videoNodeId]);
  }
  if (keyframeNodeId && videoNodeId) {
    edgesToCreate.push([keyframeNodeId, videoNodeId]);
  }

  for (const [fromNodeId, toNodeId] of edgesToCreate) {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
    const edgeRes = await host.ops.call("canvas.edge.create", {
      canvasId,
      fromNodeId,
      toNodeId,
      expectedRevision: revision,
    });
    revision = Number(edgeRes?.revision ?? revision);
  }

  return {
    canvasId,
    revision,
    controlNodeId,
    keyframeNodeId,
    videoNodeId,
    sourceKeyframeNodeId,
    targetCharacterNodeId,
    locationGuideNodeId,
    sourceVideoNodeId,
    keyframePrompt: compiled.prompt,
    videoPrompt: compiled.videoPrompt,
    locationGuide: compiled.locationGuide,
    missingReferences,
  };
}

export async function spliceReplacedShotsIntoTimeline(host, params = {}) {
  const canvasId = await resolveActiveCanvasIdAsync(host, params.canvasId);
  if (!canvasId) {
    throw new Error("请先打开目标画布或在替换工作室填写目标画布 ID 后再执行全片时间线回插");
  }
  rememberCanvasId(host, canvasId);

  const snap = await host.ops.call("canvas.get", { canvasId });
  const snapRevision = Number(snap?.revision ?? snap?.canvas?.revision);
  const revision = Number.isSafeInteger(params.expectedRevision) && params.expectedRevision >= 0
    ? params.expectedRevision
    : Number.isSafeInteger(snapRevision) && snapRevision >= 0
      ? snapRevision
      : 1;
  const existingNodes = Array.isArray(snap?.nodes)
    ? snap.nodes
    : Array.isArray(snap?.canvas?.nodes)
      ? snap.canvas.nodes
      : [];
  const existingTimeline = snap?.canvas?.timeline ?? snap?.timeline ?? null;

  const nodeDurationMap = new Map();
  for (const node of existingNodes) {
    const id = String(node?.id || "").trim();
    const dur = Number(node?.metadata?.durationMs);
    if (id && Number.isFinite(dur) && dur > 0) {
      nodeDurationMap.set(id, Math.round(dur));
    }
  }

  const fullVideoNodeId = String(params.fullVideoNodeId || "").trim();
  const detectedFullDurationMs = nodeDurationMap.get(fullVideoNodeId);
  const callerFullDurationMs = Number(params.fullDurationMs);
  let resolvedFullDurationMs = callerFullDurationMs;
  if (Number.isFinite(detectedFullDurationMs) && detectedFullDurationMs > 0) {
    if (!Number.isFinite(callerFullDurationMs) || callerFullDurationMs <= 0) {
      resolvedFullDurationMs = detectedFullDurationMs;
    } else if (Math.abs(callerFullDurationMs - detectedFullDurationMs) > 250) {
      throw new Error(
        `填写的全片总时长（${callerFullDurationMs}ms）与原全片节点实际时长（${detectedFullDurationMs}ms）不一致，请核对后重试`,
      );
    }
  }

  const enrichedReplacements = Array.isArray(params.replacements)
    ? params.replacements.map((item) => {
        const repNodeId = String(item?.nodeId || item?.replacedVideoNodeId || "").trim();
        const detectedRepDur = nodeDurationMap.get(repNodeId);
        return {
          ...item,
          sourceDurationMs: item?.sourceDurationMs ?? detectedRepDur,
        };
      })
    : [];

  const timeline = buildTimelineRangeReplacement({
    ...params,
    fullDurationMs: resolvedFullDurationMs,
    replacements: enrichedReplacements,
    existingTimeline: params.existingTimeline !== undefined ? params.existingTimeline : existingTimeline,
  });

  const updated = await host.ops.call("canvas.timeline.update", {
    canvasId,
    expectedRevision: revision,
    timeline,
  });
  return {
    canvasId,
    revision: Number(updated?.revision ?? revision + 1),
    fullDurationMs: resolvedFullDurationMs,
    timeline,
  };
}

function extractToolText(result) {
  return (result?.content || [])
    .map((part) => (part && typeof part === "object" && "text" in part && part.text ? part.text : ""))
    .join("");
}

function parseToolJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapToolResponse(res, label) {
  const text = extractToolText(res?.result || {});
  if (res?.isError) {
    throw new Error(`${label}失败：${text || "未知错误"}`);
  }
  return res?.result?.structuredContent || res?.structuredContent || parseToolJsonObject(text) || { _rawText: text };
}

export function createToolExecutorHost(executeTool) {
  return {
    context: { getCanvasId: () => "active-assistant-canvas" },
    ops: {
      call: async (op, args = {}) => {
        if (op === "canvas.get") {
          const readRes = await executeTool("canvas_get", {});
          const text = extractToolText(readRes?.result || {});
          if (readRes?.isError) {
            throw new Error(`读取画布失败：${text || "未知错误"}`);
          }
          const structured = readRes?.result?.structuredContent || readRes?.structuredContent || parseToolJsonObject(text) || {};
          const canvasObj = structured.canvas && typeof structured.canvas === "object" ? structured.canvas : structured;
          const rawRev = canvasObj.revision ?? structured.revision;
          const revision = Number.isSafeInteger(Number(rawRev))
            ? Number(rawRev)
            : Number(/"revision"\s*:\s*(\d+)/.exec(text)?.[1]);
          if (!Number.isSafeInteger(revision)) {
            throw new Error("无法确定当前画布 revision");
          }
          return {
            revision,
            nodes: Array.isArray(canvasObj.nodes) ? canvasObj.nodes : [],
            timeline: canvasObj.timeline && typeof canvasObj.timeline === "object" ? canvasObj.timeline : null,
          };
        }
        if (op === "canvas.nodes.create") {
          return unwrapToolResponse(
            await executeTool("canvas_nodes_create", {
              expectedRevision: args.expectedRevision,
              nodes: args.nodes,
            }),
            "创建角色替换节点",
          );
        }
        if (op === "canvas.node.configure") {
          return unwrapToolResponse(
            await executeTool("canvas_node_configure", {
              nodeId: args.nodeId,
              kind: args.kind,
              expectedRevision: args.expectedRevision,
              patch: args.patch,
            }),
            "配置视频元素替换节点",
          );
        }
        if (op === "canvas.edge.create") {
          return unwrapToolResponse(
            await executeTool("canvas_edge_create", {
              fromNodeId: args.fromNodeId,
              toNodeId: args.toNodeId,
              expectedRevision: args.expectedRevision,
            }),
            "连接角色替换节点",
          );
        }
        if (op === "canvas.timeline.update") {
          return unwrapToolResponse(
            await executeTool("canvas_timeline_update", {
              expectedRevision: args.expectedRevision,
              timeline: args.timeline,
            }),
            "更新全片时间线",
          );
        }
        throw new Error(`不支持的画布操作：${op}`);
      },
    },
  };
}

export async function executeCharacterReplacementArrangeTool(params = {}, executeTool) {
  const shotTitle = String(params.shotTitle || "镜头 1").trim() || "镜头 1";
  const position = normalizePosition(params.position || "single");
  const genderHint = normalizeGenderHint(params.genderHint || "person");
  const replacementScope = normalizeReplacementScope(params.replacementScope || "full-person");
  const promptMode = normalizePromptMode(params.promptMode || "regular");
  const srcKeyframeId = String(params.sourceKeyframeNodeId || "").trim();
  const targetCharId = String(params.targetCharacterNodeId || "").trim();
  const srcVideoId = String(params.sourceVideoNodeId || "").trim();

  if (params.proposeGeneration && (!srcKeyframeId || !targetCharId)) {
    throw new Error("发起关键帧换人生成提议（proposeGeneration=true）时必须提供 sourceKeyframeNodeId 与 targetCharacterNodeId");
  }

  const host = createToolExecutorHost(executeTool);
  const arranged = await arrangeCharacterReplacementOnCanvas(host, {
    ...params,
    shotTitle,
    position,
    genderHint,
    replacementScope,
    promptMode,
    canvasId: "active-assistant-canvas",
    createControlNode: true,
  });

  let proposalId;
  if (params.proposeGeneration && arranged.keyframeNodeId) {
    const parsedPropose = unwrapToolResponse(
      await executeTool("canvas_generation_propose", {
        nodeIds: [arranged.keyframeNodeId],
        kind: "image",
        ...(srcVideoId && arranged.videoNodeId ? { productionNodeIds: [arranged.keyframeNodeId, arranged.videoNodeId] } : {}),
        note: `AI 角色替换（${shotTitle}）：先生成换人关键帧，再执行视频元素替换`,
      }),
      "发起角色替换生成提议",
    );
    proposalId = typeof parsedPropose?.proposalId === "string" ? parsedPropose.proposalId : undefined;
  }

  const missingIds = [];
  if (!srcKeyframeId) missingIds.push("sourceKeyframeNodeId");
  if (!targetCharId) missingIds.push("targetCharacterNodeId");
  if (!srcVideoId) missingIds.push("sourceVideoNodeId");
  const missingNote = missingIds.length > 0 ? `（提示：尚未绑定 ${missingIds.join("、")}，生成前请先连接对应参考节点）` : "";

  return {
    content: [
      {
        type: "text",
        text: `已为「${shotTitle}」编排 AI 角色替换双阶段管线：关键帧换人节点（${arranged.keyframeNodeId}）→ 视频元素替换节点（${arranged.videoNodeId}，videoEditOperation=replace_element）${proposalId ? `，并已登记生成提议（${proposalId}）` : ""}${missingNote}。`,
      },
    ],
    details: {
      shotTitle,
      position,
      replacementScope,
      controlNodeId: arranged.controlNodeId,
      keyframeNodeId: arranged.keyframeNodeId,
      videoNodeId: arranged.videoNodeId,
      keyframePrompt: arranged.keyframePrompt,
      videoPrompt: arranged.videoPrompt,
      missingReferences: missingIds,
      revision: arranged.revision,
      proposalId,
    },
  };
}

export async function executeCharacterReplacementSpliceTool(params = {}, executeTool) {
  const host = createToolExecutorHost(executeTool);
  const fullVideoNodeId = String(params.fullVideoNodeId || "").trim();
  const res = await spliceReplacedShotsIntoTimeline(host, {
    ...params,
    fullVideoNodeId,
    keepOriginalAudio: params.keepOriginalAudio !== false,
    canvasId: "active-assistant-canvas",
  });
  const fullDurationMs = Number(res.fullDurationMs ?? res.timeline?.durationMs ?? 0);
  return {
    content: [
      {
        type: "text",
        text: `已将 ${(params.replacements || []).length} 个替换镜头无损回插至全片时间线（共生成 ${res.timeline.clips.length} 个片段，画布版本 r${res.revision}）。`,
      },
    ],
    details: {
      fullVideoNodeId,
      fullDurationMs,
      clipCount: res.timeline.clips.length,
      revision: res.revision,
      timeline: res.timeline,
    },
  };
}
