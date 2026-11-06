# BeefTV Official & Community Plugin Registry (`beeftv-plugins`)

这是 **BeefTV** 的独立插件市场注册表与官方扩展仓库（不捆绑在 BeefTV 桌面客户端安装包内，支持在线浏览、详情预览与按需安装）。

## 分发与国内加速架构（参考 DSH & Magpie）

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

## 精选推荐插件

| 插件 ID | 名称 | 版本 | 说明 |
| --- | --- | --- | --- |
| `beeftv-plugin-character-replacement` | AI 角色替换工作室 | `0.1.5` | 面向短剧与漫剧的二阶段角色替换插件：关键帧角色替换（含 SVG 框位图引导）+ 视频角色替换（`replace_element`）+ 全片时间轴回插 |
| `beeftv-plugin-comfyui` | ComfyUI | `0.1.0` | 把本机或局域网里的 ComfyUI 接进 BeefTV，保存的工作流就是模型 |
| `beeftv-plugin-runninghub` | RunningHub | `0.1.0` | 把 RunningHub 接进 BeefTV，工作流和 AI 应用就是模型 |

## 修改插件

插件源码都在 `plugins/` 下，发现问题或想加功能，直接向对应目录提 PR。合并后由维护者打包发版，用户会在 BeefTV 里收到更新。

## 开发者样板插件（位于 `plugins/`，不在精选推荐默认展示）

- `plugins/beeftv-plugin-sticky-note`：画布便签入门样板插件
- `plugins/beeftv-plugin-ecommerce-hero`：一键商品主图电商样板插件
