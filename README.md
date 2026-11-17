# BeefTV Official & Community Plugin Registry (`beeftv-plugins`)

这是 **BeefTV** 的独立插件市场注册表与扩展仓库（不捆绑在 BeefTV 桌面客户端安装包内，支持在线浏览、详情预览与按需安装）。

## 分发与国内加速架构

为保障中国大陆用户在无代理环境下也能流畅浏览插件市场、查看 `README.md` 并一键安装插件，本仓库与 BeefTV 后端提供多级加速链路：

1. **市场目录（`registry.json`）多源加速**：
   - npm 镜像目录包：`https://registry.npmmirror.com/beeftv-plugin-catalog/latest`
   - jsDelivr 国内 CDN：`https://cdn.jsdelivr.net/gh/Sunnyender-org/beeftv-plugins@main/registry.json`
   - GitHub 镜像代理：`https://gh-proxy.com/...`、`https://ghfast.top/...`
   - GitHub 官方源：`https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json`
2. **插件安装包（`.tgz` / npm）多源下载**：
   - 优先从用户所选 npm 镜像源（默认 `https://registry.npmmirror.com`）安装；
   - 支持直接下载 `registry.json` 中预打包的 `mirrorTarball`（jsDelivr CDN）与 `tarball`（GitHub Release `.tgz` 经国内镜像加速链下载）并进行 SHA-256 完整性校验；
   - 支持通过 `github:<owner>/<repo>`（含 `#path:/subpath` 子目录）在线拉取源码包安装。
3. **社区插件发现**：
   - 在 `package.json` 的 `keywords` 中包含 `"beeftv-plugin"`（及 `"pi-package"`）并发布到 npm 后，即可在 BeefTV 插件市场的「npm 社区搜索」中直接搜到并安装。

## 插件清单

### 官方扩展插件（Apache-2.0）

| 插件 ID | 名称 | 版本 | 说明 |
| --- | --- | --- | --- |
| `beeftv-plugin-character-replacement` | AI 角色替换工作室 | `0.1.6` | 面向短剧与漫剧的二阶段角色替换插件：关键帧角色替换（含 SVG 框位图引导）+ 视频角色替换（`replace_element`）+ 全片时间轴回插 |
| `beeftv-plugin-comfyui` | ComfyUI | `0.2.1` | 把本机或局域网里的 ComfyUI 接进 BeefTV，保存的工作流就是模型 |
| `beeftv-plugin-runninghub` | RunningHub | `0.1.1` | 把 RunningHub 接进 BeefTV，工作流和 AI 应用就是模型 |
| `beeftv-plugin-sticky-note` | 画布便签 | `0.1.2` | 画布便签入门样板插件，支持颜色切换与创作助手读写 |
| `beeftv-plugin-ecommerce-hero` | 一键商品主图 | `0.1.2` | 上传商品白底图/实拍图，一键编排电商主图生成节点 |

### 开源社区插件（MIT，署名 `开源社区`）

| 插件 ID | 名称 | 版本 | 说明 |
| --- | --- | --- | --- |
| `beeftv-plugin-prompt-optimizer` | AI 提示词优化器 | `0.3.1` | 把模糊的生图想法整理成可执行、可比较、适配当前模型的提示词 |
| `beeftv-plugin-eagle-asset-connector` | Eagle 素材库 | `0.3.1` | 把 Eagle 作为站点的外部素材来源，直接浏览原始文件夹并读写 Eagle 文件 |
| `beeftv-plugin-ai-art-critique` | AI 审美批改 | `0.2.0` | 分析图片的构图、色彩、光线和比例问题，输出结构化批改报告与可视化标注 |
| `beeftv-plugin-media-conversion` | 媒体转换节点 | `0.2.0` | 提供图片与视频首帧灰度、Canny 边缘、AI 线稿、深度图和 OpenPose 姿态骨架转换 |

## 修改插件与运行测试

插件源码都在 `plugins/` 下，修改后运行 `npm test` 验证全部插件逻辑与包规范，再向对应目录提 PR。合并后由维护者打包发版，用户会在 BeefTV 里收到更新。
