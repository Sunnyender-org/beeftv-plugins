import { MEDIA_CONVERSION_NODE_TYPE, MEDIA_CONVERSION_PLUGIN_ID } from "./contracts.js";
import { createMediaConversionNodeCard } from "./node-card.js";

export * from "./contracts.js";
export * from "./local-converter.js";

export function activate(host) {
  const React = host.React;
  const h = React ? React.createElement : null;
  const NodeCard = React ? createMediaConversionNodeCard(host) : () => null;

  const icon = h
    ? h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M15 4V2" }),
        h("path", { d: "M15 16v-2" }),
        h("path", { d: "M8 9h2" }),
        h("path", { d: "M20 9h2" }),
        h("path", { d: "M17.8 11.8 19 13" }),
        h("path", { d: "M15 9h0" }),
        h("path", { d: "M17.8 6.2 19 5" }),
        h("path", { d: "m3 21 9-9" }),
        h("path", { d: "M12.2 6.2 11 5" }),
      )
    : undefined;

  const disposeNode = host.contribute("canvas.node", {
    type: MEDIA_CONVERSION_NODE_TYPE,
    label: "转换",
    defaultTitle: "转换",
    defaultSize: { width: 420, height: 380 },
    minSize: { width: 400, height: 360 },
    acceptsInputKind: ["image", "video"],
    maxInputCount: 1,
    inputKind: "image",
    showOutputConnection: true,
    resourceKind: (node) => {
      const state = node?.metadata?.mediaConversion;
      if (state?.status === "completed" && state?.resultStorageKey) {
        return state.outputKind === "video" ? "video" : "image";
      }
      return null;
    },
    icon,
    component: NodeCard,
  });

  const disposeMenu = host.contribute("canvas.addNodeMenu", {
    id: MEDIA_CONVERSION_PLUGIN_ID,
    label: "转换",
    nodeType: MEDIA_CONVERSION_NODE_TYPE,
    order: 70,
    icon,
    onSelect: (ctx) => ctx?.handlers?.onAddExtensionNode?.(MEDIA_CONVERSION_NODE_TYPE),
  });

  return () => {
    disposeNode?.();
    disposeMenu?.();
  };
}

export default activate;
