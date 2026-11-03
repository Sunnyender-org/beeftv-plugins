# BeefTV Plugins Registry (`beeftv-plugins`)

本仓库维护 BeefTV 插件市场的精选推荐列表 `registry.json`。

## 重要说明

> 被推荐列表收录不代表我们为它担保；请仅安装你信任来源的插件。

## 如何发布并提交你的插件

1. **开发插件包**：一个 BeefTV 插件就是一个标准的 npm 包（同时也是标准的 `pi` package），在 `package.json` 中包含：
   - `"keywords": ["beeftv-plugin"]`
   - `"pi"`: 声明 `extensions`（助手工具）与 `skills`（技能文件）
   - `"beeftv"`: 声明 `name`、`description`、`permissions`、`client`（前端界面入口）与 `contributes`（如 `canvasNodes`、`providers` 等）
2. **发布到 npm**：运行 `npm publish --access public`。只要包含 `"beeftv-plugin"` 关键词，用户即可直接在 BeefTV 插件市场中通过 npm 社区搜索找到并安装你的插件，无需等待审核。
3. **申请进入精选推荐列表**：向本仓库提交 Pull Request，在 `registry.json` 的 `plugins` 数组中补充你的插件条目。
