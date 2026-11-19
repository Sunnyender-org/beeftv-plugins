# 无限星河 AI 多模态渠道接口说明

## 插件身份

- 插件包名：`beeftv-plugin-infistar`
- 默认 Base URL：`https://infistar.cc`（海外或备用入口：`https://infistar.ai`）
- 鉴权方式：`Authorization: Bearer <apiKey>`
- 官方接口文档：`https://doc.infistar.cc/api-overview`

## 贡献的多模态协议 Provider

| Provider ID | 能力 | 适用模型 | 创建接口 | 轮询 / 下载接口 |
| --- | --- | --- | --- | --- |
| `infistar-gemini-image` | `image` | `gemini-nano-banana-2.1`、`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image` | `POST /v1beta/models/{{model}}:generateContent` | 同步返回 |
| `infistar-image` | `image` | `doubao-seedream-5-0-260128`、`doubao-seedream-4-0-250828`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2`、`qwen-image-2.0-pro`、`qwen-image-2.0`、`wan2.7-image-pro`、`wan2.7-image`、`grok-imagine-image-quality`、`grok-imagine-image` | `POST /v1/images/generations`（无图）/ `POST /v1/images/edits`（有图 multipart） | 同步返回 |
| `infistar-video` | `video` | `doubao-seedance-2-5-260628`、`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2.0-mini`、`MiniMax-H3`、`wan3.0-video`、`wan2.7-i2v`、`wan2.7-t2v` | `POST /v1/videos`（multipart，`input_reference` 参考图） | `GET /v1/videos/{{taskId}}` / `GET /v1/videos/{{taskId}}/content` |
| `infistar-video-json` | `video` | `kling-video-o1` | `POST /v1/videos`（JSON） | `GET /v1/videos/{{taskId}}` / `GET /v1/videos/{{taskId}}/content` |

## 协议细节

1. **`infistar-gemini-image`**：使用 `originPath: true` 访问 `/v1beta/models/{{model}}:generateContent` 并携带 `Authorization: Bearer` 请求头；响应解析自动过滤带 `thought: true` 的思考草图部件，只保留最终生成图片。
2. **`infistar-image`**：无参考图走 JSON `/v1/images/generations`，带参考图或蒙版走 multipart `/v1/images/edits`（字段 `image`、`mask`）；同时兼容返回 `b64_json` 与 `url` 两种输出格式。
3. **`infistar-video`**：走 multipart `/v1/videos`，通过 `seconds` 传时长、`size` 与 `resolution` 传分辨率档位（如 `480p` / `720p` / `768p` / `1080p` / `2K`）、`ratio` 与 `aspect_ratio` 传画幅比例、`input_reference` 传单张参考图；轮询读取 `metadata.url`，若未直出链接则自动经 `/v1/videos/{{taskId}}/content` 带鉴权下载。
4. **`infistar-video-json`**：针对 `openai-video` JSON 线路（`kling-video-o1`），以 JSON 提交 `model`、`prompt`、`duration`、`aspect_ratio`、`resolution` 及可选参考图，完成后统一通过带鉴权的 `GET /v1/videos/{{taskId}}/content` 下载成片 MP4。
