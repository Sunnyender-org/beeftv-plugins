import { createPromptOptimizer } from "./optimizer.js";

export * from "./optimizer.js";
export * from "./profiles.js";

export function activate(host) {
  const React = host.React;
  const h = React ? React.createElement : () => null;
  const optimizer = createPromptOptimizer(host);

  function PromptOptimizerSettingsPanel() {
    return h(
      "div",
      {
        "data-testid": "prompt-optimizer-settings",
        style: {
          borderRadius: "var(--r-md, 10px)",
          border: "1px solid var(--border-subtle, rgba(148, 163, 184, 0.24))",
          background: "var(--surface-secondary, rgba(148, 163, 184, 0.08))",
          padding: "12px 14px",
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--user-ink, inherit)",
        },
      },
      h(
        "p",
        { style: { margin: 0 } },
        "在创作页或图片、视频节点的提示词编辑器中使用“润色”按钮，即可让当前配置的文本模型整理并适配提示词。",
      ),
      h(
        "p",
        {
          style: {
            margin: "8px 0 0",
            fontSize: 12,
            color: "var(--user-ink-muted, rgba(148, 163, 184, 0.85))",
          },
        },
        "插件不会自动覆盖原提示词，只有点击“采用”后才会回填到当前输入框。",
      ),
    );
  }

  const disposePromptAction = host.contribute("canvas.promptActions", {
    id: "prompt-optimizer",
    label: "润色",
    order: 10,
    nodeTypes: ["image", "video"],
    optimizer,
  });

  const disposeSettings = host.contribute("app.settings", {
    title: "AI 提示词优化器说明",
    component: PromptOptimizerSettingsPanel,
  });

  return () => {
    disposePromptAction?.();
    disposeSettings?.();
  };
}

export default activate;
