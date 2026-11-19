# 无限星河 AI 多模态渠道（`beeftv-plugin-infistar`）

BeefTV 官方内置合作伙伴插件，提供 **无限星河 AI (Infistar) (`https://infistar.cc`)** 的一键 BYOK 渠道配置面板以及 38 款主流文本、图像与视频模型的预置协议配置：

- **文本与多模态对话（14 款）**：`POST /v1/chat/completions`（Claude Opus / Sonnet 5.5 & 4.6、GPT-6.2 Sol / 5.4、Gemini 4 Argon / 3.8 Flash / 3.1 Pro、DeepSeek V4.1 Flash / V4 Pro、Qwen 4 Max、GLM-5.3、Kimi K3.1 Pro、MiniMax M3.1 Flash）
- **`infistar-gemini-image`（4 款 Gemini 原生生图）**：`POST /v1beta/models/{{model}}:generateContent`（`gemini-nano-banana-2.1`、`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`，支持文生图与图生图参考，自动过滤思考过程草图）
- **`infistar-image`（11 款同步图像与图编）**：`POST /v1/images/generations`（文生图 JSON）与 `POST /v1/images/edits`（图生图 multipart），覆盖 Doubao Seedream 5.0 / 4.0、GPT Image 2.5 Flare / Sunburst / 2、Qwen Image 2.0 Pro / 2.0、Wan 2.7 Image Pro / 2.7、Grok Imagine Image Quality / Standard
- **`infistar-video`（8 款统一异步视频）**：`POST /v1/videos`（multipart，支持 `input_reference` 参考图）+ `GET /v1/videos/{{taskId}}` + `GET /v1/videos/{{taskId}}/content`，覆盖 Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini、MiniMax H3、Wan 3.0 Video、Wan 2.7 I2V / T2V
- **`infistar-video-json`（1 款可灵 JSON 视频）**：`POST /v1/videos`（JSON）+ `GET /v1/videos/{{taskId}}` + `GET /v1/videos/{{taskId}}/content`（带鉴权下载成品 MP4），覆盖 `kling-video-o1`

## 专属福利

通过 BeefTV 专属链接注册可领取 5 元体验额度（具体领取条件以活动页面为准）：

- 注册与获取 API Key：`https://www.infistar.cc/register?aff=KBR9PG8Z&ref_source=link`
- 官方接口文档：`https://doc.infistar.cc/api-overview`

## 使用方式

1. 打开 BeefTV「设置 -> 模型服务 -> 连接你的模型服务」，在 **合作伙伴** 分区选择 **无限星河 AI**（或在「插件中心」打开本插件的 **「设置」** 面板）。
2. 填写无限星河 AI API Key（`sk-...`）；默认接口地址为国内优化入口 `https://infistar.cc`（也可切换为 `https://infistar.ai`）。
3. 可点击 **「验证在线目录」** 校验当前密钥的可用模型，点击保存后即可在画布与创作助手中直接使用全部预置模型。
