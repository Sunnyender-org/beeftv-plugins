import {
  artCritiqueSourceFingerprint,
  artCritiqueStageLabel,
  createDefaultArtCritiqueState,
  isArtCritiqueImageInput,
} from "./contracts.js";
import { createArtCritiqueModal } from "./modal.js";

function fallbackTheme(mode) {
  if (mode === "light") {
    return {
      canvas: { background: "#f8fafc" },
      node: { panel: "#ffffff", fill: "#f1f5f9", edge: "rgba(15,23,42,0.12)", text: "#0f172a", muted: "#64748b" },
      accent: { primary: "#2563eb", onPrimary: "#ffffff", primarySoft: "rgba(37,99,235,0.12)" },
      toolbar: { itemHover: "rgba(15,23,42,0.06)", activeText: "#0f172a" },
    };
  }
  return {
    canvas: { background: "#0b0f19" },
    node: { panel: "#141926", fill: "#1a2030", edge: "rgba(255,255,255,0.1)", text: "#f8fafc", muted: "#94a3b8" },
    accent: { primary: "#3b82f6", onPrimary: "#ffffff", primarySoft: "rgba(59,130,246,0.16)" },
    toolbar: { itemHover: "rgba(255,255,255,0.08)", activeText: "#ffffff" },
  };
}

function statusPillStyle(status) {
  if (status === "running") return { color: "var(--status-info, #3b82f6)", background: "rgba(59,130,246,0.15)" };
  if (status === "completed") return { color: "var(--status-success, #22c55e)", background: "rgba(34,197,94,0.15)" };
  if (status === "stale") return { color: "var(--status-warning, #f59e0b)", background: "rgba(245,158,11,0.15)" };
  if (status === "failed") return { color: "var(--status-error, #ef4444)", background: "rgba(239,68,68,0.15)" };
  return { color: "var(--user-ink-muted, #94a3b8)", background: "rgba(148,163,184,0.12)" };
}

function statusPillText(status, stage) {
  if (status === "running") return artCritiqueStageLabel(stage);
  if (status === "completed") return "已完成";
  if (status === "stale") return "待更新";
  if (status === "failed") return "失败";
  return "未开始";
}

export function createArtCritiqueNodeCard(host) {
  const React = host.React;
  const h = React.createElement;
  const ArtCritiqueModal = createArtCritiqueModal(host);

  return function ArtCritiqueNodeCard(props) {
    const node = props.node;
    const upstreamNodes = props.upstreamNodes || [];
    const theme = props.canvasTheme || fallbackTheme(props.theme);
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
      if (!host.events?.on) return undefined;
      return host.events.on("canvas.node:activate", (payload) => {
        if (payload?.nodeId === node?.id) setOpen(true);
      });
    }, [node?.id]);

    const imageInputs = upstreamNodes.filter(isArtCritiqueImageInput);
    const input = imageInputs[0];
    const state =
      props.data?.artCritique ||
      node?.metadata?.pluginData?.artCritique ||
      node?.metadata?.artCritique ||
      createDefaultArtCritiqueState();
    const currentFingerprint = input ? artCritiqueSourceFingerprint(input) : "";
    const hasStaleReport = Boolean(state.report && (!currentFingerprint || state.report.sourceFingerprint !== currentFingerprint));
    const status = hasStaleReport ? "stale" : state.status;
    const rawPreview = input?.metadata?.previewContent || input?.metadata?.content || "";
    const safeFallback = rawPreview ? (host.media?.renderableMediaUrl?.(rawPreview) ?? "") : "";
    const [previewUrl, setPreviewUrl] = React.useState(safeFallback);

    React.useEffect(() => {
      let active = true;
      setPreviewUrl(safeFallback);
      if (!input || input.type !== "image" || (!input.metadata?.storageKey && !rawPreview)) {
        return () => { active = false; };
      }
      if (host.media?.resolveImageUrl) {
        void host.media.resolveImageUrl(input.metadata?.storageKey, rawPreview, { cacheMiss: true, renderable: true })
          .then((resolved) => {
            if (active) setPreviewUrl(resolved || safeFallback);
          })
          .catch(() => {
            if (active) setPreviewUrl(safeFallback);
          });
      }
      return () => { active = false; };
    }, [input?.id, input?.type, input?.metadata?.storageKey, rawPreview, safeFallback]);

    const issueCount = state.report?.issues?.length || 0;
    const optionCount = state.report?.options?.length || 0;
    const canOpen = Boolean(state.report) || Boolean(input);

    const handleUpdateState = (nodeId, nextState) => {
      if (node?.metadata?.artCritique !== undefined && props.updateMetadata) {
        props.updateMetadata(nodeId, {
          pluginData: { ...(node?.metadata?.pluginData || {}), artCritique: nextState },
          artCritique: undefined,
        });
        return;
      }
      if (props.updateData) {
        props.updateData({ artCritique: nextState });
      } else if (props.updateMetadata) {
        props.updateMetadata(nodeId, {
          pluginData: { ...(node?.metadata?.pluginData || {}), artCritique: nextState },
        });
      }
    };

    return h(
      "div",
      {
        onPointerDown: (e) => e.stopPropagation(),
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "100%",
          height: "100%",
          padding: 12,
          boxSizing: "border-box",
          overflow: "hidden",
          background: theme.node.panel,
          color: theme.node.text,
          borderRadius: "inherit",
        },
      },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
        h("div", { style: { minWidth: 0, flex: 1 } },
          h("div", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "AI 审美批改"),
          h("div", { style: { fontSize: 11, color: theme.node.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "视觉分析 · SVG 标注 · 不修改原图"),
        ),
        h("span", { style: { ...statusPillStyle(status), borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 600, flexShrink: 0 } },
          statusPillText(status, state.analysisStage),
        ),
      ),
      h(
        "div",
        { style: { position: "relative", flex: 1, minHeight: 0, borderRadius: "var(--r-md, 8px)", border: `1px solid ${theme.node.edge}`, background: theme.node.fill, overflow: "hidden" } },
        previewUrl && input?.type === "image"
          ? h("img", { src: previewUrl, alt: "", draggable: false, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" } })
          : h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12, color: theme.node.muted } }, "等待图片输入"),
        h(
          "div",
          { style: { position: "absolute", left: 0, right: 0, bottom: 0, padding: "24px 10px 8px", background: "linear-gradient(to top, rgba(0,0,0,0.75), transparent)", color: "#fff", pointerEvents: "none", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 8 } },
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, input ? input.title || "输入图片" : "等待图片输入"),
            h("div", { style: { fontSize: 11, opacity: 0.78 } },
              input
                ? (state.report ? (issueCount ? `${issueCount} 个重点问题` : optionCount ? `${optionCount} 个可选方向，无确定问题` : "本轮未发现重点问题") : "尚未生成报告")
                : "从图片节点拖入一条连线",
            ),
          ),
          status === "completed" && issueCount > 0 && h("span", { style: { background: "rgba(0,0,0,0.45)", borderRadius: 999, padding: "2px 8px", fontSize: 11, fontWeight: 600, flexShrink: 0 } }, `${issueCount} 项`),
        ),
      ),
      status === "stale" && h("div", { style: { padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(245,158,11,0.5)", background: "rgba(245,158,11,0.09)", color: "var(--status-warning, #f59e0b)", fontSize: 11 } }, input ? "输入图片已变化，需要重新批改" : "未连接输入图片，当前展示上次批改报告"),
      status === "failed" && state.errorMessage && h("div", { style: { padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.09)", color: "var(--status-error, #ef4444)", fontSize: 11 } }, state.errorMessage),
      state.report && status === "completed" && h("div", { style: { padding: "6px 10px", borderRadius: 8, border: `1px solid ${theme.node.edge}`, background: theme.node.fill, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        state.report.summary || `已完成 ${issueCount} 项批改`,
      ),
      h(
        "button",
        {
          type: "button",
          "data-canvas-no-zoom": "",
          disabled: !canOpen,
          onClick: (e) => {
            e.stopPropagation();
            setOpen(true);
          },
          style: {
            width: "100%",
            minHeight: 40,
            borderRadius: "var(--r-md, 8px)",
            border: "none",
            background: theme.accent.primary,
            color: theme.accent.onPrimary,
            fontSize: 13,
            fontWeight: 600,
            cursor: canOpen ? "pointer" : "not-allowed",
            opacity: canOpen ? 1 : 0.5,
          },
        },
        status === "running" ? "正在批改" : state.report ? (status === "stale" ? "重新批改" : "查看批改报告") : "开始 AI 批改",
      ),
      open && h(ArtCritiqueModal, {
        node,
        data: props.data,
        upstreamNodes,
        open,
        theme,
        onClose: () => setOpen(false),
        onUpdateState: handleUpdateState,
      }),
    );
  };
}
