const genericImageProfile = {
  id: "generic-image",
  label: "通用图片模型",
  promptShape: "自然语言描述，按主体与动作 → 环境 → 构图 → 光线与材质 → 风格排列。",
  rules: [
    "先锁定主体、数量、身份和动作，再补充可见的画面细节。",
    "把重要的比例、文字、位置和一致性要求写明确。",
  ],
  avoid: [
    "不要臆造供应商参数或控制语法。",
    "关键规避项不要只放在 negativePrompt 中，正向提示词也要表达清楚。",
  ],
};

const genericVideoProfile = {
  id: "generic-video",
  label: "通用视频模型",
  promptShape: "单镜头时序描述，按起始画面 → 主体动作 → 镜头运动 → 环境变化 → 结尾状态排列。",
  rules: [
    "每个动作使用可观察、连续的动词，避免一段话塞入互不相连的多个镜头。",
    "明确主体、镜头和环境谁在运动，并保持角色、服装和场景一致。",
  ],
  avoid: [
    "不要把静态摄影参数堆成关键词列表。",
    "不要新增用户未要求的转场、角色或剧情。",
  ],
};

function containsAny(value, keywords) {
  return keywords.some((keyword) => value.includes(keyword));
}

export function resolveModelAdaptationProfile(input) {
  const model = `${input.targetModel || ""} ${input.targetProtocol || ""}`.toLowerCase();
  if (input.generationMode === "image") {
    if (containsAny(model, ["gemini", "imagen", "nano-banana", "nanobanana"])) {
      return {
        id: "gemini-image",
        label: "Gemini / Imagen 图片模型",
        promptShape: "清晰的自然语言场景描述，按主体 → 背景与上下文 → 风格与摄影细节组织。",
        rules: [
          "优先使用完整句子和具体视觉事实，参考图只描述确实可见的内容。",
          "如果画面含文字，保留原文并明确位置、层级和字数，避免无关装饰。",
          "控制提示词长度，先保留主体、上下文和风格这三个核心层次。",
        ],
        avoid: ["不要使用 SD 权重、反向提示词标签或未确认的供应商参数。"],
      };
    }
    if (containsAny(model, ["gpt-image", "dall-e", "dalle", "openai-image", "openai"])) {
      return {
        id: "openai-image",
        label: "OpenAI 图片模型",
        promptShape: "简洁、完整的自然语言描述，先说要生成什么，再补充构图、光线、材质和风格。",
        rules: [
          "使用模型能直接理解的画面描述，不把提示词写成控制台参数。",
          "对画面中的文字、位置、数量和主体关系使用明确句子。",
        ],
        avoid: [
          "不要添加 SD 权重、逗号关键词堆叠或 -- 参数。",
          "不要依赖单独 negativePrompt，重要限制要写进正向描述。",
        ],
      };
    }
    if (containsAny(model, ["grok-image", "grok-imagine"])) {
      return {
        id: "grok-image",
        label: "Grok 图片模型",
        promptShape: "简洁的自然语言画面描述，主体、动作、环境和视觉风格清晰分层。",
        rules: [
          "保留明确的主体关系、构图和风格意图，避免把提示词写成参数清单。",
          "有参考图时说明要保留的主体或风格特征，不臆测看不见的细节。",
        ],
        avoid: ["不要添加 SD 权重、Midjourney 参数或模型未确认支持的控制语法。"],
      };
    }
    if (
      containsAny(model, [
        "seedream",
        "jimeng",
        "doubao",
        "volcengine-ark-image",
        "volcengine-ark-agent-plan-image",
        "volcengine-jimeng-image",
      ])
    ) {
      return {
        id: "seedream-image",
        label: "Seedream / 即梦 / 火山图片模型",
        promptShape: "中文自然语言镜头描述，按主体与动作 → 构图 → 光影 → 材质与风格组织。",
        rules: [
          "优先写清人物或主体的外观、动作、空间关系和画面重点。",
          "需要人物一致性时重复关键外观特征，避免只写抽象的‘保持一致’。",
          "中文需求保持中文表达，英文专有名词只在确实有帮助时保留。",
        ],
        avoid: [
          "不要套用 SD 的权重语法、质量词串或无意义的英文标签。",
          "不要把多个镜头和互相冲突的动作混在一条提示词里。",
        ],
      };
    }
    if (containsAny(model, ["flux"])) {
      return {
        id: "flux-image",
        label: "FLUX 图片模型",
        promptShape: "自然语言段落 + 少量明确的视觉关键词，主体和动作放在前面。",
        rules: [
          "用具体关系描述主体、位置、材质和光线，而不是重复质量形容词。",
          "保留用户指定的风格和构图，不主动添加模型参数。",
        ],
        avoid: [
          "不要输出很长的逗号标签清单或堆叠 negative prompt。",
          "不要添加未经用户要求的 LoRA、采样器或权重标记。",
        ],
      };
    }
    if (containsAny(model, ["sdxl", "stable-diffusion", "stable diffusion", "sd3", "stable3"])) {
      return {
        id: "stable-diffusion-image",
        label: "Stable Diffusion / SDXL 图片模型",
        promptShape: "紧凑的分层关键词或短句，按主体 → 构图 → 光线 → 风格与质量组织。",
        rules: [
          "只保留能影响画面的关键词，主体和构图优先。",
          "如果原提示词已经使用括号权重，只在确有必要时保留并少量调整。",
          "将画面主体和反向规避项分开表达，避免互相冲突。",
        ],
        avoid: [
          "不要盲目添加过多质量词、艺术家名或模型专属标签。",
          "不确定权重语法是否被当前渠道支持时，不要主动新增。",
        ],
      };
    }
    if (containsAny(model, ["midjourney", "mid-journey"])) {
      return {
        id: "midjourney-image",
        label: "Midjourney 图片模型",
        promptShape: "精炼的视觉描述，主体、场景、构图和风格清晰，参数放在末尾。",
        rules: [
          "优先写画面内容和视觉方向，保持短而有辨识度。",
          "只有用户原本提供或明确要求时才保留 --ar、--stylize 等参数。",
        ],
        avoid: [
          "不要臆造 Midjourney 参数或把所有摄影术语都堆上去。",
          "不要使用与当前工作台协议无关的命令前缀。",
        ],
      };
    }
    if (containsAny(model, ["ideogram", "recraft"])) {
      return {
        id: "design-image",
        label: "设计与文字图片模型",
        promptShape: "先说明画布、主体和版式，再说明文字内容、位置、层级、字体气质和配色。",
        rules: ["画面文字保留精确原文并控制字数，明确文字与主体的空间关系。", "区分内容、版式和视觉风格，避免只给抽象审美词。"],
        avoid: ["不要擅自改写品牌名、标题、数字或标语。"],
      };
    }
    return genericImageProfile;
  }

  if (
    containsAny(model, [
      "seedance",
      "doubao-seedance",
      "volcengine-ark-video",
      "volcengine-ark-agent-plan-video",
      "volcengine-jimeng-video",
      "jimeng-video",
    ])
  ) {
    return {
      id: "seedance-video",
      label: "Seedance / 即梦视频模型",
      promptShape: "单镜头时序描述，明确起始构图、动作节拍、镜头运动、环境变化和结尾状态。",
      rules: [
        "用连续动作描述主体如何开始、发展和结束，保持镜头内的因果关系。",
        "人物、服装、场景和道具的一致性优先于堆叠风格词。",
        "有首帧或参考图时，明确哪些内容必须保持、哪些内容允许变化。",
      ],
      avoid: ["不要在一条提示词中拼接多个无关镜头。", "不要把静态图片参数当成视频动作指令。"],
    };
  }
  if (containsAny(model, ["veo", "gemini-veo"])) {
    return {
      id: "veo-video",
      label: "Veo 视频模型",
      promptShape: "电影化的自然语言镜头描述，按主体、动作、镜头、环境和节奏组织。",
      rules: ["把想法拆成可观察的动作和镜头运动，并补充时间顺序。", "用景别、机位、运镜、光线和环境声等可视化要素控制镜头。"],
      avoid: ["不要只写情绪和抽象风格，不给动作或镜头变化。", "不要加入用户未要求的多镜头转场。"],
    };
  }
  if (containsAny(model, ["kling"])) {
    return {
      id: "kling-video",
      label: "Kling 视频模型",
      promptShape: "简洁、连续的动作指令，明确主体运动和摄像机运动。",
      rules: [
        "每个动作都写清主体、方向、速度或结果，避免互相冲突的动作。",
        "优先保证物理连续性、角色一致性和镜头稳定。",
      ],
      avoid: ["不要加入过多抽象叙事或无法在短片段中完成的事件。"],
    };
  }
  if (containsAny(model, ["runway", "gen-3", "gen3", "minimax-video", "hailuo", "wan", "ltx-video", "hunyuan-video"])) {
    return {
      id: "general-video-family",
      label: "通用视频模型",
      promptShape: "以单个镜头为单位描述起始画面、动作过程、摄影机和结束画面。",
      rules: [
        "动作使用连续动词，明确运动主体和摄像机，不把结果写成静态形容词。",
        "保持角色、服装、场景和光线的连续性。",
      ],
      avoid: ["不要堆砌静态图片关键词或一次安排过多动作。"],
    };
  }
  return genericVideoProfile;
}
