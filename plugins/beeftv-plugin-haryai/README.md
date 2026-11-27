# beeftv-plugin-haryai：在 BeefTV 里用 HaryAI 的模型

填一个 [HaryAI](https://haryai.com/zh?utm_source=github&utm_medium=readme&utm_campaign=beeftv-plugin-haryai) 的 API Key，一键把 HaryAI 的模型同步到 BeefTV 的「设置 → 模型服务」，画布、视频生成、图片生成和创作助手里都能直接选。

| 种类 | 模型 | 价格 |
|---|---|---|
| 视频 | Seedance 2.5、Seedance 2.5 Flash，以及内容限制更少的 Unlock 版 | 官方价 88 折起 |
| 图片 | Seedream 5.5、Nano Banana 2.1、Nano Banana 2 | Seedream 8 折，Nano Banana 5 折 |
| 对话 | DeepSeek V4.1 Flash、DeepSeek V4 Pro（可当创作助手的模型） | 官方价 45 折 |

模型清单在同步时从 https://haryai.com/models.json 读取，HaryAI 上新模型后点一次「保存并同步模型」就有。

## 安装

1. BeefTV 打开「插件」，点「安装」，在「npm 插件包」里填 `beeftv-plugin-haryai`，确认安装。
2. 在插件列表里找到 HaryAI，点「设置」。
3. 填 [HaryAI 账户页](https://haryai.com/zh/dashboard?utm_source=github&utm_medium=readme&utm_campaign=beeftv-plugin-haryai) 里的 API Key，点「保存并同步模型」。

之后在节点左下角选模型，供应商是 HaryAI。

## 说明

- Seedance 支持文生视频、首尾帧和全能参考（参考图、参考视频、参考音频）。参考视频每段 2 到 30 秒，合计不超过 30 秒，至少 480p。
- 按用量从 HaryAI 余额扣费，失败的任务不扣费。全部价格见 [价格页](https://haryai.com/zh/pricing?utm_source=github&utm_medium=readme&utm_campaign=beeftv-plugin-haryai)。
- 插件只写入它自己的「HaryAI」渠道，不改动其他渠道。

## 相关

- [seedance-2.5-api](https://github.com/haryai-com/seedance-2.5-api)：Seedance 2.5 的 API 和示例
- [nano-banana-api](https://github.com/haryai-com/nano-banana-api)：Nano Banana 2.1 和 2 的 API
- [n8n-nodes-haryai](https://github.com/haryai-com/n8n-nodes-haryai)：在 n8n 里用 Seedance 2.5
