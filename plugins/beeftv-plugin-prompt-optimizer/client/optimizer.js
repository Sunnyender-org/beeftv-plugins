import { resolveModelAdaptationProfile } from "./profiles.js";

const modeLabels = {
  expand: "扩展想法",
  refine: "精修已有提示词",
  style: "强化视觉风格",
  "model-adapt": "适配当前模型",
  reference: "结合参考素材",
};

export const optimizerTool = {
  type: "function",
  function: {
    name: "optimize_prompt",
    description: "返回结构化的 AI 生图或生视频提示词优化结果。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["optimizedPrompt", "negativePrompt", "changes", "assumptions", "variants"],
      properties: {
        optimizedPrompt: { type: "string", description: "可直接用于生成的正向提示词。" },
        negativePrompt: { type: "string", description: "需要规避的内容；没有时返回空字符串。" },
        changes: { type: "array", items: { type: "string" }, description: "相较输入提示词做出的关键变化。" },
        assumptions: { type: "array", items: { type: "string" }, description: "对模糊需求做出的假设；没有时返回空数组。" },
        variants: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "prompt"],
            properties: {
              label: { type: "string" },
              prompt: { type: "string" },
            },
          },
          description: "最多两个可选的提示词版本。",
        },
      },
    },
  },
};

const systemPrompt = [
  "你是当前创作工作台里的提示词导演，负责把用户模糊的视觉想法整理成可以直接交给生成模型的提示词。",
  "只优化表达和可执行性，不擅自改变用户明确写出的主体、身份、动作、数量、时代、地点、画幅比例或安全约束。",
  "优先使用具体可视化语言：主体与关系、构图与景别、动作、环境、材质、光线、色彩、镜头和风格。",
  "如果输入已经足够明确，保持原意并做克制的精修；如果信息不足，把不确定项写入 assumptions，不要假装知道。",
  "根据 generationMode 选择表达：图片侧重静态画面、构图和材质，视频侧重动作连续性、时长感、镜头运动和首尾衔接。",
  "当优化模式是适配当前模型时，先结合 targetProtocol 和 targetModel 判断模型族，再严格执行模型适配策略；不要编造不存在的参数、权重语法或模型能力。",
  "最终必须调用 optimize_prompt 工具，不要输出 Markdown，不要在工具调用之外解释。",
].join("\n");

export function buildUserMessage(
  input,
  modelProfile = input.mode === "model-adapt" ? resolveModelAdaptationProfile(input) : null,
) {
  const textParts = [
    `优化模式：${modeLabels[input.mode] || input.mode}`,
    `目标类型：${input.generationMode === "image" ? "图片" : "视频"}`,
    `目标生成模型：${input.targetModel?.trim() || "未指定"}`,
    `目标接口协议：${input.targetProtocol?.trim() || "未指定"}`,
    "",
    "用户原始提示词：",
    input.prompt?.trim() || "（用户还没有写出具体提示词，请从参考上下文中提炼一个可执行版本）",
  ];
  if (modelProfile) {
    textParts.push(
      "",
      `模型适配策略：${modelProfile.label}`,
      `建议提示词结构：${modelProfile.promptShape}`,
      "必须遵守：",
      ...modelProfile.rules.map((rule) => `- ${rule}`),
      "避免：",
      ...modelProfile.avoid.map((rule) => `- ${rule}`),
      "请在 changes 中明确说明已经采用的模型适配要点。",
    );
  }
  if (input.context?.texts?.length) {
    textParts.push("", "已连接的文本上下文：", ...input.context.texts.map((item) => `- ${item.title}：${item.text}`));
  }
  if (input.context?.images?.length) {
    textParts.push(
      "",
      "已连接的参考图已作为图片输入，请只在确实可见的内容上做判断：",
      ...input.context.images.map((item) => `- ${item.title}`),
    );
  }
  textParts.push(
    "",
    "输出要求：",
    "1. optimizedPrompt 是一段可以直接复制到当前生成节点的提示词。",
    "2. negativePrompt 只填写明确有帮助的规避项，没有就留空。",
    "3. changes 和 assumptions 使用简短中文条目。",
    "4. variants 最多给出两个明显不同但仍忠于原意的版本，没有必要时返回空数组。",
  );

  const content = [{ type: "text", text: textParts.join("\n") }];
  for (const image of input.context?.images || []) {
    const url = typeof image?.url === "string" ? image.url.trim() : "";
    if (/^(data:|https?:\/\/)/i.test(url)) content.push({ type: "image_url", image_url: { url } });
  }
  return { role: "user", content };
}

export function parseJsonObject(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const candidates = [cleaned];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 某些兼容模型会在 JSON 外包一层解释，继续尝试截取对象部分。
    }
  }
  return null;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseVariants(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const label = typeof item.label === "string" ? item.label.trim() : "备选版本";
      const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
      return prompt ? [{ label: label || "备选版本", prompt }] : [];
    })
    .slice(0, 2);
}

export function normalizeResult(value, sourcePrompt, modelProfile) {
  const optimizedPrompt = typeof value?.optimizedPrompt === "string" ? value.optimizedPrompt.trim() : "";
  const negativePrompt = typeof value?.negativePrompt === "string" ? value.negativePrompt.trim() : "";
  return {
    optimizedPrompt: optimizedPrompt || String(sourcePrompt || "").trim(),
    negativePrompt,
    changes: stringArray(value?.changes),
    assumptions: stringArray(value?.assumptions),
    variants: parseVariants(value?.variants),
    modelProfile: modelProfile ? { id: modelProfile.id, label: modelProfile.label } : undefined,
  };
}

export function createPromptOptimizer(host) {
  return {
    optimize: async (input, options) => {
      const textService = host?.ai?.text;
      if (!textService?.requestToolResponse) {
        throw new Error("提示词优化器暂未获得文本模型服务，请确认已授予文本模型权限");
      }
      const modelProfile = input.mode === "model-adapt" ? resolveModelAdaptationProfile(input) : null;
      const response = await textService.requestToolResponse({
        model: input.optimizerModel,
        messages: [{ role: "system", content: systemPrompt }, buildUserMessage(input, modelProfile)],
        tools: [optimizerTool],
        toolChoice: { type: "function", name: "optimize_prompt" },
        signal: options?.signal,
        onDelta: options?.onDelta,
      });
      const toolCall = (response.toolCalls || []).find(
        (call) => (call?.name ?? call?.function?.name) === "optimize_prompt",
      );
      const parsed = parseJsonObject(
        toolCall?.arguments ?? toolCall?.function?.arguments ?? response.content,
      );
      return normalizeResult(parsed, input.prompt, modelProfile);
    },
  };
}
