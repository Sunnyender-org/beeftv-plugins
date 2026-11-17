import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeCharacterReplacementArrangeTool,
  executeCharacterReplacementSpliceTool,
} from "../client/canvas-arrangement.js";

export default function registerCharacterReplacementExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "character_replacement_arrange",
    label: "一键编排 AI 角色替换双阶段管线",
    description:
      "在当前画布创建「AI 角色替换」配置节点、Step 2 关键帧人物替换图片节点与 Step 3 视频元素替换（replace_element）节点，自动连接原关键帧、目标角色参考图、可选定位图与原视频，并可选直接发起生成提议。",
    parameters: Type.Object({
      shotTitle: Type.String({
        description: "镜头名称，例如「镜头 1」或「雨夜拔剑特写」",
      }),
      sourceDescription: Type.String({
        description: "原画面中被替换人物的特征描述，例如「穿黑西装的男人」或「银甲男剑客」",
      }),
      targetDescription: Type.String({
        description: "目标替换角色的外貌与服装描述，例如「戴银框眼镜、穿酒红色丝绒西装的年轻霸总」",
      }),
      position: Type.Optional(
        Type.String({
          description: "目标人物在画面中的位置：single（单人）| left（左侧）| center（中间）| right（右侧）",
          default: "single",
        }),
      ),
      genderHint: Type.Optional(
        Type.String({
          description: "人物性别提示：person（不限）| male（男）| female（女）",
          default: "person",
        }),
      ),
      replacementScope: Type.Optional(
        Type.String({
          description:
            "替换范围：full-person（完整人物）| visible-part（当前可见部分）| face-hair（脸部和头发）| clothing（仅服装）| arm-hand（手臂和手部）",
          default: "full-person",
        }),
      ),
      promptMode: Type.Optional(
        Type.String({
          description:
            "提示词模式：regular（常规位置描述）| positioning（SVG 定位框辅助）| manual（自定义提示词）",
          default: "regular",
        }),
      ),
      manualPrompt: Type.Optional(
        Type.String({
          description: "当 promptMode 为 manual 时的自定义关键帧换人提示词",
        }),
      ),
      sourceKeyframeNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的原视频关键帧图片节点 ID（将自动作为图1连接到关键帧换人节点）",
        }),
      ),
      targetCharacterNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的目标角色参考图节点 ID（将自动作为图2连接到关键帧换人节点）",
        }),
      ),
      locationGuideNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的人物定位框图节点 ID（在 positioning 模式下将作为图3连接到关键帧换人节点）",
        }),
      ),
      sourceVideoNodeId: Type.Optional(
        Type.String({
          description: "画布上已有的原镜头视频节点 ID（将自动连接到 Step 3 视频角色替换节点）",
        }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "当前画布版本号（未传时自动读取）" }),
      ),
      proposeGeneration: Type.Optional(
        Type.Boolean({
          description: "创建并连线后是否立即发起关键帧换人生成提议（canvas_generation_propose）",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeCharacterReplacementArrangeTool(params, (name, args) => ctx.executeTool(name, args));
    },
  });

  pi.registerTool({
    name: "character_replacement_splice_timeline",
    label: "将角色替换后的镜头视频无损回插至全片时间线",
    description:
      "根据原全片视频节点、全片总时长及一个或多个替换后的镜头视频区间（startMs~endMs），构建「原片前段 → 替换镜头 → 原片后段」的无损 Timeline v2 并写入画布时间线（保留画布既有字幕/BGM 轨道）。",
    parameters: Type.Object({
      fullVideoNodeId: Type.String({
        description: "原全片视频节点 ID",
      }),
      fullDurationMs: Type.Optional(
        Type.Number({
          description: "原全片视频总时长（毫秒，如 15000；未传时自动读取原全片节点的 durationMs）",
          minimum: 100,
        }),
      ),
      replacements: Type.Array(
        Type.Object({
          nodeId: Type.String({ description: "替换完成后的镜头视频节点 ID" }),
          startMs: Type.Number({ description: "在原全片中的起始毫秒（如 3000）", minimum: 0 }),
          endMs: Type.Number({ description: "在原全片中的结束毫秒（如 8000）", minimum: 100 }),
        }),
        { minItems: 1, description: "需要回插的替换镜头区间列表" },
      ),
      keepOriginalAudio: Type.Optional(
        Type.Boolean({
          description: "是否保留原全片完整连续音轨（默认 true，静音视频片段轨并叠加原片完整音频轨）",
          default: true,
        }),
      ),
      expectedRevision: Type.Optional(
        Type.Number({ description: "当前画布版本号（未传时自动读取）" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return executeCharacterReplacementSpliceTool(params, (name, args) => ctx.executeTool(name, args));
    },
  });
}
