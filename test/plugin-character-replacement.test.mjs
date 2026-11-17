import assert from "node:assert/strict";
import test from "node:test";

import {
  activate,
  arrangeCharacterReplacementOnCanvas,
  buildCharacterReplacementPackage,
  buildLocationGuideSvgDataUrl,
  buildTimelineRangeReplacement,
  compileCharacterReplacementPrompt,
  executeCharacterReplacementArrangeTool,
  executeCharacterReplacementSpliceTool,
  normalizePosition,
  normalizeReplacementScope,
  spliceReplacedShotsIntoTimeline,
  uniqueNodeTitle,
} from "../plugins/beeftv-plugin-character-replacement/client/index.js";

test("character-replacement compilers build prompts, SVG location guides, and Timeline v2 splices", () => {
  assert.equal(normalizeReplacementScope("FACE-HAIR"), "face-hair");
  assert.equal(normalizePosition("RIGHT"), "right");

  const titles = new Set(["角色替换"]);
  assert.equal(uniqueNodeTitle("角色替换", titles), "角色替换 #2");

  const svg = buildLocationGuideSvgDataUrl({
    frame: { width: 16, height: 9 },
    people: [{ markerLabel: "A", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 } }],
  });
  assert.match(svg.dataUrl, /^data:image\/svg\+xml/);
  assert.equal(svg.personCount, 1);

  const pkg = buildCharacterReplacementPackage({
    promptMode: "positioning",
    people: [
      { id: "p1", position: "left", genderHint: "female", targetDescription: "红衣侠客", replacementScope: "full-person" },
    ],
  });
  assert.match(pkg.prompt, /图1/);
  assert.match(pkg.prompt, /红衣侠客/);
  assert.ok(pkg.locationGuide);

  const regular = compileCharacterReplacementPrompt({ promptMode: "regular", targetDescription: "机甲战士" });
  assert.match(regular, /机甲战士/);

  const timeline = buildTimelineRangeReplacement({
    fullVideoNodeId: "src-video",
    fullDurationMs: 10000,
    keepOriginalAudio: true,
    replacements: [{ nodeId: "shot-2", startMs: 2000, endMs: 5000 }],
  });
  assert.equal(timeline.version, 2);
  assert.equal(timeline.tracks.length, 2);
  const videoClips = timeline.clips.filter((c) => c.kind === "video");
  const audioClips = timeline.clips.filter((c) => c.kind === "audio");
  assert.deepEqual(
    videoClips.map((c) => ({ nodeId: c.nodeId, startMs: c.startMs, durationMs: c.durationMs })),
    [
      { nodeId: "src-video", startMs: 0, durationMs: 2000 },
      { nodeId: "shot-2", startMs: 2000, durationMs: 3000 },
      { nodeId: "src-video", startMs: 5000, durationMs: 5000 },
    ],
  );
  assert.equal(audioClips.length, 1);
  assert.deepEqual({ startMs: audioClips[0].startMs, durationMs: audioClips[0].durationMs }, { startMs: 0, durationMs: 10000 });
});

test("character-replacement activate registers expected canvas and assistant slots", () => {
  const slots = [];
  const dispose = activate({
    React: null,
    contribute: (slot, payload) => {
      slots.push({ slot, payload });
      return () => {};
    },
    ui: {},
    context: { getCanvasId: () => "c1" },
  });
  const nodeSlot = slots.find((s) => s.slot === "canvas.node" && s.payload.type === "character-replacement");
  assert.ok(nodeSlot);
  assert.equal(nodeSlot.payload.title, "AI 角色替换");
  assert.deepEqual(nodeSlot.payload.defaultSize, { width: 380, height: 460 });
  assert.ok(slots.some((s) => s.slot === "app.page"));
  const arrangeCard = slots.find((s) => s.slot === "assistant.toolCard" && s.payload.toolName === "character_replacement_arrange");
  assert.ok(arrangeCard);
  assert.equal(arrangeCard.payload.id, "character-replacement-tool-card");
  assert.equal(arrangeCard.payload.label, "AI 角色替换管线编排");
  if (typeof dispose === "function") dispose();
});

test("arrangeCharacterReplacementOnCanvas creates nodes/edges with revision tracking and enforces missing-reference guard", async () => {
  const opsCalls = [];
  let revision = 3;
  let seq = 0;
  const host = {
    context: { getCanvasId: () => "canvas-char-1" },
    storage: {
      data: new Map(),
      get(k) { return this.data.get(k); },
      set(k, v) { this.data.set(k, v); },
    },
    ops: {
      call: async (op, args) => {
        opsCalls.push({ op, args });
        if (op === "canvas.get") {
          return { revision, nodes: [{ id: "existing-1", title: "镜头 1 · 关键帧换人" }] };
        }
        if (op === "canvas.nodes.create") {
          assert.equal(args.expectedRevision, revision);
          revision += 1;
          return {
            revision,
            created: args.nodes.map((n) => ({ id: `node-${++seq}`, title: n.title, type: n.type })),
          };
        }
        if (op === "canvas.node.configure" || op === "canvas.edge.create") {
          assert.equal(args.expectedRevision, revision);
          revision += 1;
          return { revision };
        }
        throw new Error(`unexpected op: ${op}`);
      },
    },
  };

  await assert.rejects(
    arrangeCharacterReplacementOnCanvas(host, { requireReferences: true, shotTitle: "镜头 1" }),
    /缺少必需的上游参考节点/,
  );

  const partial = await arrangeCharacterReplacementOnCanvas(host, {
    shotTitle: "镜头 1",
    sourceKeyframeNodeId: "src-kf",
    targetCharacterNodeId: "ref-char",
    targetDescription: "机甲战士",
  });
  assert.equal(partial.canvasId, "canvas-char-1");
  assert.deepEqual(partial.missingReferences, ["sourceVideoNodeId（原镜头视频节点）"]);
  assert.equal(partial.keyframeNodeId, "node-1");
  assert.equal(partial.videoNodeId, "node-2");
  assert.equal(partial.revision, 8);
  const configureCall = opsCalls.find((c) => c.op === "canvas.node.configure");
  assert.equal(configureCall.args.nodeId, "node-2");
  assert.equal(configureCall.args.patch.videoEditOperation, "replace_element");
  const edgePairs = opsCalls.filter((c) => c.op === "canvas.edge.create").map((c) => [c.args.fromNodeId, c.args.toNodeId]);
  assert.deepEqual(edgePairs, [
    ["src-kf", "node-1"],
    ["ref-char", "node-1"],
    ["node-1", "node-2"],
  ]);

  const autoRes = await arrangeCharacterReplacementOnCanvas(host, {
    shotTitle: "镜头 2",
    autoCreateInputNodes: true,
    promptMode: "positioning",
    targetDescription: "红衣侠客",
  });
  assert.deepEqual(autoRes.missingReferences, []);
  assert.ok(autoRes.sourceKeyframeNodeId && autoRes.targetCharacterNodeId && autoRes.locationGuideNodeId && autoRes.sourceVideoNodeId);
});

test("spliceReplacedShotsIntoTimeline builds Timeline v2 payload and rejects duration mismatch", async () => {
  let committed = null;
  const host = {
    context: { getCanvasId: () => "canvas-tl-1" },
    ops: {
      call: async (op, args) => {
        if (op === "canvas.get") {
          return {
            revision: 5,
            nodes: [
              { id: "full-vid", metadata: { durationMs: 10000 } },
              { id: "shot-2", metadata: { durationMs: 3200 } },
            ],
            timeline: null,
          };
        }
        if (op === "canvas.timeline.update") {
          committed = args;
          return { revision: 6 };
        }
        throw new Error(`unexpected op: ${op}`);
      },
    },
  };

  await assert.rejects(
    spliceReplacedShotsIntoTimeline(host, {
      fullVideoNodeId: "full-vid",
      fullDurationMs: 20000,
      replacements: [{ nodeId: "shot-2", startMs: 2000, endMs: 5000 }],
    }),
    /不一致/,
  );

  const res = await spliceReplacedShotsIntoTimeline(host, {
    fullVideoNodeId: "full-vid",
    keepOriginalAudio: true,
    replacements: [{ nodeId: "shot-2", startMs: 2000, endMs: 5000 }],
  });
  assert.equal(res.canvasId, "canvas-tl-1");
  assert.equal(res.revision, 6);
  assert.equal(committed.expectedRevision, 5);
  const videoClips = committed.timeline.clips.filter((c) => c.kind === "video");
  const audioClips = committed.timeline.clips.filter((c) => c.kind === "audio");
  assert.deepEqual(
    videoClips.map((c) => ({ nodeId: c.nodeId, startMs: c.startMs, durationMs: c.durationMs })),
    [
      { nodeId: "full-vid", startMs: 0, durationMs: 2000 },
      { nodeId: "shot-2", startMs: 2000, durationMs: 3000 },
      { nodeId: "full-vid", startMs: 5000, durationMs: 5000 },
    ],
  );
  assert.equal(audioClips.length, 1);
  assert.equal(audioClips[0].durationMs, 10000);
});

test("assistant extension tool handlers share orchestration core and propagate configure/edge/timeline errors", async () => {
  const makeExecutor = (failTool = "") => {
    let rev = 10;
    return async (name, args) => {
      if (name === failTool) {
        return { isError: true, result: { content: [{ text: `${name} boom` }] } };
      }
      if (name === "canvas_get") {
        return {
          result: {
            structuredContent: {
              revision: rev,
              nodes: [
                { id: "src-vid", metadata: { durationMs: 8000 } },
                { id: "rep-vid", metadata: { durationMs: 3000 } },
              ],
              timeline: {
                version: 2,
                tracks: [{ id: "track-sub", kind: "subtitle", label: "字幕", order: 2, visible: true }],
                clips: [{ id: "sub-1", kind: "subtitle", trackId: "track-sub", startMs: 0, durationMs: 12000, text: "尾声字幕" }],
              },
            },
          },
        };
      }
      if (name === "canvas_nodes_create") {
        rev += 1;
        return {
          result: {
            structuredContent: {
              revision: rev,
              created: args.nodes.map((n, i) => ({ id: `ext-${i + 1}`, type: n.type })),
            },
          },
        };
      }
      if (name === "canvas_node_configure" || name === "canvas_edge_create" || name === "canvas_timeline_update") {
        rev += 1;
        return { result: { structuredContent: { revision: rev } } };
      }
      if (name === "canvas_generation_propose") {
        return { result: { structuredContent: { proposalId: "prop-42" } } };
      }
      throw new Error(`unexpected tool: ${name}`);
    };
  };

  await assert.rejects(
    executeCharacterReplacementArrangeTool(
      { shotTitle: "镜头A", sourceDescription: "黑衣男", targetDescription: "红衣女" },
      makeExecutor("canvas_node_configure"),
    ),
    /配置视频元素替换节点失败：canvas_node_configure boom/,
  );

  await assert.rejects(
    executeCharacterReplacementArrangeTool(
      {
        shotTitle: "镜头A",
        sourceDescription: "黑衣男",
        targetDescription: "红衣女",
        sourceKeyframeNodeId: "kf-0",
      },
      makeExecutor("canvas_edge_create"),
    ),
    /连接角色替换节点失败：canvas_edge_create boom/,
  );

  const okArrange = await executeCharacterReplacementArrangeTool(
    {
      shotTitle: "镜头A",
      sourceDescription: "黑衣男",
      targetDescription: "红衣女",
      sourceKeyframeNodeId: "kf-0",
      targetCharacterNodeId: "char-0",
      sourceVideoNodeId: "src-vid",
      proposeGeneration: true,
    },
    makeExecutor(),
  );
  assert.equal(okArrange.details.controlNodeId, "ext-1");
  assert.equal(okArrange.details.keyframeNodeId, "ext-2");
  assert.equal(okArrange.details.videoNodeId, "ext-3");
  assert.equal(okArrange.details.proposalId, "prop-42");

  await assert.rejects(
    executeCharacterReplacementSpliceTool(
      { fullVideoNodeId: "src-vid", replacements: [{ nodeId: "rep-vid", startMs: 1000, endMs: 4000 }] },
      makeExecutor("canvas_timeline_update"),
    ),
    /更新全片时间线失败：canvas_timeline_update boom/,
  );

  const okSplice = await executeCharacterReplacementSpliceTool(
    { fullVideoNodeId: "src-vid", replacements: [{ nodeId: "rep-vid", startMs: 1000, endMs: 4000 }] },
    makeExecutor(),
  );
  assert.equal(okSplice.details.clipCount, 5);
  assert.equal(okSplice.details.fullDurationMs, 8000);
});
