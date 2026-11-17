import {
  createDefaultMediaConversionState,
  isLocalImageOperation,
  MEDIA_CONVERSION_OPERATION_LABELS,
  mediaConversionOperationDescription,
  mediaConversionOperationLabel,
  mediaConversionSourceFingerprint,
} from "./contracts.js";
import { convertImageLocally, LocalImageConversionError } from "./local-converter.js";

const OPERATIONS = Object.keys(MEDIA_CONVERSION_OPERATION_LABELS);

function fallbackTheme(mode) {
  if (mode === "light") {
    return {
      node: { panel: "#ffffff", fill: "#f1f5f9", edge: "rgba(15,23,42,0.12)", text: "#0f172a", muted: "#64748b" },
      accent: { primary: "#2563eb", onPrimary: "#ffffff" },
      toolbar: { itemHover: "rgba(15,23,42,0.06)", activeText: "#0f172a" },
    };
  }
  return {
    node: { panel: "#141926", fill: "#1a2030", edge: "rgba(255,255,255,0.1)", text: "#f8fafc", muted: "#94a3b8" },
    accent: { primary: "#3b82f6", onPrimary: "#ffffff" },
    toolbar: { itemHover: "rgba(255,255,255,0.08)", activeText: "#ffffff" },
  };
}

function statusMeta(status) {
  if (status === "processing") return { text: "处理中", label: "正在处理", color: "var(--status-info, #3b82f6)", bg: "rgba(59,130,246,0.15)" };
  if (status === "completed") return { text: "已完成", label: "已完成", color: "var(--status-success, #22c55e)", bg: "rgba(34,197,94,0.15)" };
  if (status === "stale") return { text: "待更新", label: "输入已变化，结果待更新", color: "var(--status-warning, #f59e0b)", bg: "rgba(245,158,11,0.15)" };
  if (status === "error") return { text: "失败", label: "处理失败", color: "var(--status-error, #ef4444)", bg: "rgba(239,68,68,0.15)" };
  if (status === "unavailable") return { text: "本地不可用", label: "本地能力不可用", color: "var(--status-warning, #f59e0b)", bg: "rgba(245,158,11,0.15)" };
  if (status === "skipped") return { text: "已跳过", label: "未检测到人物姿态", color: "var(--status-warning, #f59e0b)", bg: "rgba(245,158,11,0.15)" };
  return { text: "未开始", label: "尚未转换", color: "var(--user-ink-muted, #94a3b8)", bg: "rgba(148,163,184,0.12)" };
}

function localRuntimeNotice(error, runtimeState) {
  if (runtimeState?.connection === "unreachable") return "本地模型服务未启动，请双击 start-beeftv-local.cmd 后重试";
  if (error.code === "depth_model_missing") return "深度模型尚未安装，请先完成本地模型安装";
  if (error.code === "lineart_model_missing") return "AI 线稿依赖或模型尚未安装，请先完成本地线稿模型安装";
  if (error.code === "pose_model_missing") return "姿态模型或依赖尚未安装，请先完成本地姿态模型安装";
  return error.message;
}

export function createMediaConversionNodeCard(host) {
  const React = host.React;
  const h = React.createElement;

  return function MediaConversionNodeCard(props) {
    const node = props.node;
    const upstream = props.upstreamNodes || [];
    const theme = props.canvasTheme || fallbackTheme(props.theme);
    const { updateMetadata, updateNode, openVideoSegment } = props;
    const runtimeState = host.media?.getLocalRuntimeState?.() || { connection: "unknown", connecting: false };
    const [reconnecting, setReconnecting] = React.useState(Boolean(runtimeState.connecting));

    const mediaInputs = upstream.filter((item) => item.type === "image" || item.type === "video");
    const input = mediaInputs[0];
    const inputKind = input?.type === "video" ? "video" : input?.type === "image" ? "image" : undefined;
    const state = node?.metadata?.mediaConversion || createDefaultMediaConversionState();
    const currentFingerprint = input
      ? (host.media?.mediaConversionSourceFingerprint?.(input) ?? mediaConversionSourceFingerprint(input))
      : "";
    const hasMultipleInputs = mediaInputs.length > 1;
    const isStale = Boolean(state.status === "completed" && (!currentFingerprint || state.sourceFingerprint !== currentFingerprint));
    const status = isStale ? "stale" : state.status;

    const [sourceUrl, setSourceUrl] = React.useState("");
    const [resultUrl, setResultUrl] = React.useState("");
    const [showResult, setShowResult] = React.useState(status === "completed" || status === "stale");
    const [notice, setNotice] = React.useState("");
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const abortRef = React.useRef(null);

    React.useEffect(() => {
      let active = true;
      const rawFallback = input?.metadata?.previewContent || input?.metadata?.content || "";
      const videoSource = input?.type === "video" ? (input?.metadata?.content || rawFallback) : rawFallback;
      const safeFallback = videoSource ? (host.media?.renderableMediaUrl?.(videoSource) ?? "") : "";
      setSourceUrl(safeFallback);
      if (!input || (!input.metadata?.storageKey && !videoSource)) return () => { active = false; };
      if (input.type === "image") {
        if (!host.media?.resolveImageUrl) return () => { active = false; };
        void host.media.resolveImageUrl(input.metadata?.storageKey, rawFallback, { cacheMiss: true, renderable: true })
          .then((resolved) => { if (active) setSourceUrl(resolved || safeFallback); })
          .catch(() => { if (active) setSourceUrl(safeFallback); });
        return () => { active = false; };
      }
      if (!host.media?.resolveMediaUrl) return () => { active = false; };
      void host.media.resolveMediaUrl(input.metadata?.storageKey, videoSource, { renderable: true })
        .then((resolved) => { if (active) setSourceUrl(resolved || safeFallback); })
        .catch(() => { if (active) setSourceUrl(safeFallback); });
      return () => { active = false; };
    }, [input?.id, input?.metadata?.content, input?.metadata?.previewContent, input?.metadata?.storageKey, input?.type]);

    React.useEffect(() => {
      let active = true;
      setResultUrl("");
      if (!state.resultStorageKey || !host.media?.resolveImageUrl) return () => { active = false; };
      void host.media.resolveImageUrl(state.resultStorageKey, "", { cacheMiss: true, renderable: true })
        .then((resolved) => { if (active) setResultUrl(resolved); })
        .catch(() => { if (active) setResultUrl(""); });
      return () => { active = false; };
    }, [state.resultStorageKey]);

    React.useEffect(() => {
      if ((!updateNode && !updateMetadata) || !currentFingerprint || state.status !== "completed" || state.sourceFingerprint === currentFingerprint) return;
      const markStale = (current) => {
        if (!current || current.status !== "completed" || current.sourceFingerprint === currentFingerprint) return current;
        return { ...current, status: "stale", updatedAt: new Date().toISOString() };
      };
      if (updateNode) {
        updateNode(node.id, (current) => {
          const next = markStale(current.metadata?.mediaConversion);
          if (!next || next === current.metadata?.mediaConversion) return current;
          return { ...current, metadata: { ...current.metadata, mediaConversion: next } };
        });
        return;
      }
      updateMetadata?.(node.id, { mediaConversion: { ...state, status: "stale", updatedAt: new Date().toISOString() } });
    }, [currentFingerprint, node?.id, state, updateMetadata, updateNode]);

    React.useEffect(() => {
      if (status === "stale") setShowResult(false);
    }, [status]);

    React.useEffect(() => () => abortRef.current?.abort(), []);

    const updateState = (patch) => {
      if (updateNode) {
        updateNode(node.id, (current) => ({
          ...current,
          metadata: {
            ...current.metadata,
            mediaConversion: {
              ...(current.metadata?.mediaConversion || createDefaultMediaConversionState()),
              ...patch,
              schemaVersion: 1,
            },
          },
        }));
        return;
      }
      updateMetadata?.(node.id, { mediaConversion: { ...state, ...patch, schemaVersion: 1 } });
    };

    const selectOperation = (operation) => {
      setPickerOpen(false);
      if (operation === state.operation) return;
      setNotice("");
      updateState({
        operation,
        status: state.resultStorageKey ? "stale" : "idle",
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: new Date().toISOString(),
      });
      setShowResult(false);
    };

    const run = async () => {
      setNotice("");
      if (!input || !currentFingerprint) {
        setNotice("请先连接一张图片或一个视频");
        return;
      }
      if (hasMultipleInputs) {
        setNotice("转换节点只能连接一个输入，请移除多余连线");
        return;
      }
      if (inputKind === "video" && !isLocalImageOperation(state.operation)) {
        updateState({
          status: "unavailable",
          outputKind: "image",
          errorCode: "video_operation_not_ready",
          errorMessage: "视频转换目前支持灰度图和 Canny 边缘；高级模型仍需逐帧处理",
          updatedAt: new Date().toISOString(),
        });
        setNotice("视频转换目前支持灰度图和 Canny 边缘");
        return;
      }
      if (!isLocalImageOperation(state.operation) && !["depth", "lineart", "pose"].includes(state.operation)) {
        updateState({
          status: "unavailable",
          outputKind: "image",
          errorCode: "model_missing",
          errorMessage: "该转换需要先安装并验证本地模型",
          updatedAt: new Date().toISOString(),
        });
        setNotice(mediaConversionOperationDescription(state.operation));
        return;
      }
      if (!sourceUrl) {
        updateState({ status: "error", errorCode: "source_unreadable", errorMessage: "图片预览尚未准备好，请稍后重试", updatedAt: new Date().toISOString() });
        setNotice("图片预览尚未准备好，请稍后重试");
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = new Date().toISOString();
      updateState({
        status: "processing",
        sourceNodeId: input.id,
        sourceFingerprint: currentFingerprint,
        outputKind: "image",
        errorCode: undefined,
        errorMessage: undefined,
        startedAt,
        updatedAt: startedAt,
      });

      let posterObjectUrl = "";
      try {
        let conversionSourceUrl = sourceUrl;
        if (inputKind === "video") {
          const captured = await host.media.captureVideoPoster(sourceUrl, { signal: controller.signal, maxWidth: 1024 });
          if (captured?.poster) {
            posterObjectUrl = URL.createObjectURL(captured.poster);
            conversionSourceUrl = posterObjectUrl;
          } else if (input.metadata?.previewContent) {
            const safePreview = host.media?.renderableMediaUrl?.(input.metadata.previewContent) || "";
            const resolvedPreview = safePreview || (host.media?.resolveImageUrl ? await host.media.resolveImageUrl(undefined, input.metadata.previewContent, { cacheMiss: true, renderable: true }).catch(() => "") : "");
            if (!resolvedPreview) {
              throw new LocalImageConversionError("source_unreadable", "无法读取视频首帧，请确认视频编码格式兼容");
            }
            conversionSourceUrl = resolvedPreview;
          } else {
            throw new LocalImageConversionError("source_unreadable", "无法读取视频首帧，请确认视频编码格式兼容");
          }
        }
        const result = isLocalImageOperation(state.operation)
          ? await convertImageLocally(conversionSourceUrl, state.operation, { signal: controller.signal, maxDimension: 1024 })
          : await host.media.runLocalPreprocess(state.operation, sourceUrl, controller.signal);
        if (controller.signal.aborted) return;

        const userScope = host.utils?.getActiveUserScope?.() || "default";
        const storageKey = `image:${userScope}:media-conversion:${node.id}:${currentFingerprint}:${state.operation}`;
        const url = await host.media.saveImageBlob(storageKey, result.blob);
        const completedAt = new Date().toISOString();
        const detectedPeople = state.operation === "pose" && typeof result.personCount === "number" ? result.personCount : undefined;
        const completedPatch = {
          content: "",
          previewContent: "",
          storageKey,
          mimeType: result.blob.type || "image/png",
          bytes: result.blob.size,
          naturalWidth: result.width,
          naturalHeight: result.height,
        };
        const completedConversion = {
          schemaVersion: 1,
          operation: state.operation,
          status: "completed",
          sourceNodeId: input.id,
          sourceFingerprint: currentFingerprint,
          outputKind: "image",
          resultStorageKey: storageKey,
          resultWidth: result.width,
          resultHeight: result.height,
          ...(detectedPeople !== undefined ? { detectedPeople } : {}),
          errorCode: undefined,
          errorMessage: undefined,
          startedAt,
          updatedAt: completedAt,
        };
        if (updateNode) {
          updateNode(node.id, (current) => ({
            ...current,
            metadata: {
              ...current.metadata,
              ...completedPatch,
              mediaConversion: { ...(current.metadata?.mediaConversion || createDefaultMediaConversionState()), ...completedConversion },
            },
          }));
        } else {
          updateMetadata?.(node.id, { ...completedPatch, mediaConversion: { ...state, ...completedConversion } });
        }
        setResultUrl(url);
        setShowResult(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof LocalImageConversionError && error.code === "aborted") return;
        if (error && error.name === "LocalRuntimeClientError") {
          if (error.code === "pose_no_person") {
            updateState({ status: "skipped", errorCode: error.code, errorMessage: error.message, detectedPeople: 0, updatedAt: new Date().toISOString() });
            setNotice("未检测到可用人物姿态，可更换含人物的图片或选择其他转换方式");
            return;
          }
          const nextStatus = ["depth_model_missing", "depth_runtime_unavailable", "lineart_model_missing", "lineart_runtime_unavailable", "pose_model_missing", "pose_runtime_unavailable"].includes(error.code)
            ? "unavailable"
            : "error";
          updateState({ status: nextStatus, errorCode: error.code, errorMessage: error.message, updatedAt: new Date().toISOString() });
          setNotice(localRuntimeNotice(error, host.media.getLocalRuntimeState?.()));
          return;
        }
        const convError = error instanceof LocalImageConversionError ? error : new LocalImageConversionError("source_unreadable", error instanceof Error ? error.message : "本地图片转换失败");
        updateState({ status: convError.code === "model_missing" ? "unavailable" : "error", errorCode: convError.code, errorMessage: convError.message, updatedAt: new Date().toISOString() });
        setNotice(convError.message);
      } finally {
        if (posterObjectUrl) URL.revokeObjectURL(posterObjectUrl);
      }
    };

    const downloadResult = () => {
      if (!resultUrl || typeof document === "undefined") return;
      const link = document.createElement("a");
      link.href = resultUrl;
      link.download = `${node?.title || "转换结果"}-${state.operation}.png`;
      link.click();
    };

    const openVideoEditing = () => {
      if (inputKind !== "video") return;
      if (!input) { setNotice("请先连接一个视频节点"); return; }
      if (openVideoSegment) { openVideoSegment(input); return; }
      setNotice("视频剪辑工作流尚未连接");
    };

    const badge = statusMeta(status);
    const effectiveResult = Boolean(resultUrl && (status === "completed" || status === "stale"));
    const displayResult = showResult && effectiveResult;
    const buttonDisabled = !input || hasMultipleInputs || status === "processing";
    const videoNeedsEditing = inputKind === "video" && !isLocalImageOperation(state.operation);
    const previewStatusText = state.operation === "pose" && status === "completed" && typeof state.detectedPeople === "number"
      ? `${badge.label} · ${state.detectedPeople} 人`
      : badge.label;
    const currentRuntime = host.media.getLocalRuntimeState?.() || runtimeState;
    const showRuntimeRecovery = ["depth", "lineart", "pose"].includes(state.operation) &&
      (currentRuntime.connection === "unreachable" || ["depth_runtime_unavailable", "lineart_runtime_unavailable", "pose_runtime_unavailable"].includes(state.errorCode));

    const retryLocalRuntime = async () => {
      setNotice("");
      setReconnecting(true);
      try {
        const next = await host.media.reconnectLocalRuntime();
        setNotice(next?.connection === "connected" ? "本地模型服务已连接，可以重新开始转换" : next?.error || "本地模型服务仍未连接，请先运行 start-beeftv-local.cmd");
      } finally {
        setReconnecting(false);
      }
    };

    return h(
      "div",
      {
        onPointerDown: (e) => e.stopPropagation(),
        onWheel: (e) => e.stopPropagation(),
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
          h("div", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, node?.title || "转换"),
          h("div", { style: { fontSize: 11, color: theme.node.muted } }, node?.title === "智能剪辑" ? "智能剪辑 · 本地处理" : "本地处理 · 单图优先"),
        ),
        h("span", { style: { color: badge.color, background: badge.bg, borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 600, flexShrink: 0 } }, badge.text),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0 } },
        h(
          "div",
          { style: { position: "relative", flex: 1, minHeight: 0, borderRadius: "var(--r-md, 8px)", border: `1px solid ${theme.node.edge}`, background: theme.node.fill, overflow: "hidden" } },
          displayResult
            ? h("img", { src: resultUrl, alt: `${mediaConversionOperationLabel(state.operation)}结果`, draggable: false, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" } })
            : input?.type === "image" && sourceUrl
              ? h("img", { src: sourceUrl, alt: "转换输入", draggable: false, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" } })
              : input?.type === "video" && sourceUrl
                ? h("video", { src: sourceUrl, controls: true, preload: "metadata", style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" } })
                : h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12, color: theme.node.muted } }, "等待输入"),
          h(
            "div",
            { style: { position: "absolute", left: 0, right: 0, bottom: 0, padding: "24px 10px 8px", background: "linear-gradient(to top, rgba(0,0,0,0.75), transparent)", color: "#fff", pointerEvents: "none", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 8 } },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, displayResult ? (status === "stale" ? "上次结果 · 待更新" : "转换结果") : input?.title || "等待输入"),
              h("div", { style: { fontSize: 11, opacity: 0.78 } }, hasMultipleInputs ? "已连接多个输入" : input ? `${input.type === "video" ? "视频" : "图片"} · ${previewStatusText}` : "连接图片或视频节点"),
            ),
            state.resultWidth && state.resultHeight && displayResult && h("span", { style: { fontSize: 11, flexShrink: 0 } }, `${state.resultWidth} × ${state.resultHeight}`),
          ),
        ),
        effectiveResult && h(
          "div",
          { style: { display: "flex", gap: 6 }, "data-canvas-no-zoom": "" },
          h("button", { type: "button", "aria-pressed": !showResult, onClick: (e) => { e.stopPropagation(); setShowResult(false); }, style: { flex: 1, height: 26, borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", background: !showResult ? theme.accent.primary : "rgba(148,163,184,0.12)", color: !showResult ? theme.accent.onPrimary : theme.node.muted } }, "原素材"),
          h("button", { type: "button", "aria-pressed": showResult, onClick: (e) => { e.stopPropagation(); setShowResult(true); }, style: { flex: 1, height: 26, borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", background: showResult ? theme.accent.primary : "rgba(148,163,184,0.12)", color: showResult ? theme.accent.onPrimary : theme.node.muted } }, "结果"),
          h("button", { type: "button", "aria-label": "下载转换结果", title: "下载转换结果", onClick: (e) => { e.stopPropagation(); downloadResult(); }, style: { width: 38, height: 26, borderRadius: 6, border: `1px solid ${theme.node.edge}`, background: "transparent", color: theme.node.muted, fontSize: 11, cursor: "pointer" } }, "下载"),
        ),
      ),
      h(
        "div",
        { style: { position: "relative", display: "flex", flexDirection: "column", gap: 8 }, "data-canvas-no-zoom": "" },
        h(
          "button",
          {
            type: "button",
            disabled: status === "processing",
            onClick: (e) => { e.stopPropagation(); setPickerOpen((o) => !o); },
            style: {
              height: 36,
              width: "100%",
              padding: "0 10px",
              borderRadius: "var(--r-md, 8px)",
              border: `1px solid ${pickerOpen ? theme.accent.primary : theme.node.edge}`,
              background: pickerOpen ? theme.toolbar.itemHover : theme.node.fill,
              color: theme.node.text,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              fontWeight: 600,
              cursor: status === "processing" ? "not-allowed" : "pointer",
            },
          },
          h("span", null, `转换方式：${mediaConversionOperationLabel(state.operation)}`),
          h("span", { style: { fontSize: 11, color: theme.node.muted } }, pickerOpen ? "▲" : "▼"),
        ),
        pickerOpen && h(
          "div",
          {
            role: "listbox",
            "aria-label": "转换方式",
            style: {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 84,
              zIndex: 50,
              maxHeight: 220,
              overflowY: "auto",
              borderRadius: 10,
              border: `1px solid ${theme.node.edge}`,
              background: theme.node.panel,
              padding: 4,
              boxShadow: "0 14px 34px rgba(0,0,0,0.32)",
            },
          },
          OPERATIONS.map((operation) =>
            h(
              "button",
              {
                key: operation,
                type: "button",
                role: "option",
                "aria-selected": operation === state.operation,
                onClick: (e) => { e.stopPropagation(); selectOperation(operation); },
                style: {
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  border: "none",
                  borderRadius: 6,
                  background: operation === state.operation ? theme.toolbar.itemHover : "transparent",
                  color: theme.node.text,
                  cursor: "pointer",
                  display: "block",
                },
              },
              h("div", { style: { fontSize: 12, fontWeight: 600 } }, mediaConversionOperationLabel(operation)),
              h("div", { style: { fontSize: 11, color: theme.node.muted, marginTop: 2 } }, mediaConversionOperationDescription(operation)),
            ),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            disabled: buttonDisabled,
            onClick: (e) => {
              e.stopPropagation();
              if (videoNeedsEditing) openVideoEditing();
              else void run();
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
              cursor: buttonDisabled ? "not-allowed" : "pointer",
              opacity: buttonDisabled ? 0.5 : 1,
            },
          },
          videoNeedsEditing ? "打开视频剪辑" : status === "processing" ? "处理中" : status === "completed" || status === "stale" ? "重新转换" : "开始转换",
        ),
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: status === "unavailable" || status === "skipped" ? "var(--status-warning, #f59e0b)" : notice || status === "error" ? "var(--status-error, #ef4444)" : theme.node.muted } },
        h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: notice || mediaConversionOperationDescription(state.operation) },
          notice || mediaConversionOperationDescription(state.operation),
        ),
        showRuntimeRecovery && h(
          "button",
          { type: "button", disabled: reconnecting, onClick: (e) => { e.stopPropagation(); void retryLocalRuntime(); }, style: { border: "none", background: "transparent", color: theme.accent.primary, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 } },
          reconnecting ? "连接中" : "重试连接",
        ),
      ),
    );
  };
}
