import { ART_CRITIQUE_NODE_TYPE, ART_CRITIQUE_PLUGIN_ID } from "./contracts.js";
import { createArtCritiqueNodeCard } from "./node-card.js";

export * from "./annotation.js";
export * from "./contracts.js";
export * from "./pipeline.js";
export * from "./pipeline-tools.js";
export * from "./rubrics.js";

export function activate(host) {
  const React = host.React;
  const h = React ? React.createElement : null;
  const NodeCard = React ? createArtCritiqueNodeCard(host) : () => null;

  const icon = h
    ? h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M3 7V5a2 2 0 0 1 2-2h2" }),
        h("path", { d: "M17 3h2a2 2 0 0 1 2 2v2" }),
        h("path", { d: "M21 17v2a2 2 0 0 1-2 2h-2" }),
        h("path", { d: "M7 21H5a2 2 0 0 1-2-2v-2" }),
        h("circle", { cx: 12, cy: 12, r: 3 }),
      )
    : undefined;

  const disposeNode = host.contribute("canvas.node", {
    type: ART_CRITIQUE_NODE_TYPE,
    label: "AI 审美批改",
    defaultTitle: "AI 审美批改",
    defaultSize: { width: 560, height: 420 },
    schema: { type: "object", properties: { artCritique: { type: "object" } } },
    acceptsInputKind: "image",
    maxInputCount: 1,
    showOutputConnection: false,
    icon,
    component: NodeCard,
  });

  const disposeMenu = host.contribute("canvas.addNodeMenu", {
    id: ART_CRITIQUE_PLUGIN_ID,
    label: "AI 审美批改",
    nodeType: ART_CRITIQUE_NODE_TYPE,
    order: 75,
    icon,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.(ART_CRITIQUE_NODE_TYPE),
  });

  return () => {
    disposeNode?.();
    disposeMenu?.();
  };
}

export default activate;
