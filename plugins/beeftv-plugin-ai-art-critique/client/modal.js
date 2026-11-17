import {
  ART_CRITIQUE_CATEGORY_COLORS,
  ART_CRITIQUE_SEVERITY_COLORS,
  layoutArtCritiqueLabels,
  repairIssueTarget,
  targetBounds,
} from "./annotation.js";
import {
  ART_CRITIQUE_SCHEMA_VERSION,
  artCritiqueCategoryLabel,
  artCritiqueSeverityLabel,
  artCritiqueSourceFingerprint,
  artCritiqueStageLabel,
  createDefaultArtCritiqueState,
  isArtCritiqueImageInput,
} from "./contracts.js";
import { executeArtCritique } from "./pipeline.js";

const CATEGORIES = ["composition", "color", "lighting", "proportion", "other"];
const STAGE_PROGRESS = {
  preparing: 8,
  scene: 22,
  reviewing: 52,
  aggregating: 66,
  grounding: 78,
  verifying: 90,
  annotating: 97,
  completed: 100,
  failed: 100,
};

function smallBtnStyle(theme, primary = false) {
  return {
    height: 30,
    padding: "0 12px",
    borderRadius: "var(--r-md, 8px)",
    border: primary ? "none" : `1px solid ${theme.node.edge}`,
    background: primary ? theme.accent.primary : "transparent",
    color: primary ? theme.accent.onPrimary : theme.node.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };
}

export function createArtCritiqueModal(host) {
  const React = host.React;
  const h = React.createElement;

  function CritiqueOverlay({ issues, issueNumberById, labelPlacements, onSelect }) {
    return h(
      "svg",
      {
        viewBox: "0 0 100 100",
        preserveAspectRatio: "xMidYMid meet",
        role: "img",
        "aria-label": "AI 批改标注",
        style: { position: "absolute", inset: 12, width: "calc(100% - 24px)", height: "calc(100% - 24px)", pointerEvents: "none" },
      },
      h("title", null, "AI 批改标注"),
      issues.map((issue, index) => {
        const renderIssue = repairIssueTarget(issue);
        const issueNumber = issueNumberById.get(renderIssue.id) || index + 1;
        const color = ART_CRITIQUE_SEVERITY_COLORS[renderIssue.severity];
        const approximate = renderIssue.target.type !== "box";
        const uncertain = renderIssue.targetSource === "reference" || renderIssue.verification?.verdict === "uncertain";
        const label = labelPlacements[index] || { x: 0.04, y: 0.06 };
        const bounds = targetBounds(renderIssue.target);
        const labelX = label.x * 100;
        const labelY = label.y * 100;
        return h(
          "g",
          {
            key: renderIssue.id,
            role: "button",
            tabIndex: 0,
            "aria-label": `${issueNumber}：${renderIssue.title}`,
            style: { pointerEvents: "auto", cursor: "pointer" },
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => onSelect(renderIssue.id),
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(renderIssue.id);
              }
            },
          },
          h("rect", {
            x: bounds.x * 100,
            y: bounds.y * 100,
            width: bounds.width * 100,
            height: bounds.height * 100,
            rx: "1.4",
            fill: color,
            fillOpacity: ".08",
            stroke: color,
            strokeWidth: 0.95,
            strokeDasharray: renderIssue.target.type === "global" || approximate || uncertain ? "2.2 1.6" : undefined,
            vectorEffect: "non-scaling-stroke",
          }),
          h("rect", {
            x: labelX - 3.2,
            y: labelY - 2.55,
            width: "6.4",
            height: "5.1",
            rx: "1.7",
            fill: color,
            fillOpacity: ".96",
            stroke: "#fff",
            strokeOpacity: ".9",
            strokeWidth: ".55",
            vectorEffect: "non-scaling-stroke",
          }),
          h("text", { x: labelX, y: labelY + 1.05, textAnchor: "middle", fill: "#fff", fontSize: "3.05", fontWeight: "700" }, String(issueNumber)),
          h("title", null, `${issueNumber}：${renderIssue.title}`),
        );
      }),
    );
  }

  return function ArtCritiqueModal({ node, upstreamNodes, open, theme, onClose, onUpdateState }) {
    const textConfig = host.ai?.getTextModelConfig?.() || { model: "", modelLabel: "未配置文本/视觉理解模型", hasModel: false };
    const selectedCritiqueModel = String(textConfig.model || "").trim();
    const configuredCritiqueModelLabel = selectedCritiqueModel ? (textConfig.modelLabel || selectedCritiqueModel) : "未配置文本/视觉理解模型";
    const input = React.useMemo(() => {
      const images = (upstreamNodes || []).filter(isArtCritiqueImageInput);
      return images.length === 1 ? images[0] : undefined;
    }, [upstreamNodes]);

    const state =
      props.data?.artCritique ||
      node?.metadata?.pluginData?.artCritique ||
      node?.metadata?.artCritique ||
      createDefaultArtCritiqueState();
    const currentFingerprint = input ? artCritiqueSourceFingerprint(input) : "";
    const stale = Boolean(state.report && (!currentFingerprint || state.report.sourceFingerprint !== currentFingerprint));
    const visibleState = stale && state.status !== "running" ? { ...state, status: "stale" } : state;

    const [previewUrl, setPreviewUrl] = React.useState("");
    const [running, setRunning] = React.useState(false);
    const [activeStage, setActiveStage] = React.useState(undefined);
    const [localError, setLocalError] = React.useState("");
    const [filter, setFilter] = React.useState("all");
    const [view, setView] = React.useState("overview");
    const [selectedIssueId, setSelectedIssueId] = React.useState(null);
    const [hoveredIssueId, setHoveredIssueId] = React.useState(null);
    const [draftReportVisible, setDraftReportVisible] = React.useState(false);
    const abortRef = React.useRef(null);
    const currentRunTargetRef = React.useRef("");
    currentRunTargetRef.current = `${host.utils?.getActiveUserScope?.() || ""}:${node?.id || ""}:${currentFingerprint}`;

    React.useEffect(() => {
      if (!open || !input) {
        setPreviewUrl("");
        return;
      }
      let cancelled = false;
      const source = input.metadata?.content || input.metadata?.previewContent || "";
      const fallback = host.media.renderableMediaUrl(source);
      void host.media.resolveImageUrl(input.metadata?.storageKey, source, { cacheMiss: true, renderable: true })
        .then((url) => { if (!cancelled) setPreviewUrl(url || fallback); })
        .catch(() => { if (!cancelled) setPreviewUrl(fallback); });
      return () => { cancelled = true; };
    }, [input, open]);

    React.useEffect(() => {
      setSelectedIssueId(null);
      setHoveredIssueId(null);
      setView("overview");
      setFilter("all");
      setActiveStage(undefined);
      setLocalError("");
      setDraftReportVisible(false);
    }, [node?.id, currentFingerprint, open]);

    React.useEffect(() => () => abortRef.current?.abort(), [node?.id, currentFingerprint]);

    if (!open) return null;

    const issues = visibleState.report?.issues || [];
    const reportOptions = visibleState.report?.options || [];
    const repairedIssues = issues.map(repairIssueTarget);
    const visibleIssues = filter === "all" ? repairedIssues : repairedIssues.filter((issue) => issue.category === filter);
    const detailIssue = repairedIssues.find((issue) => issue.id === selectedIssueId) || null;
    const detailIndex = detailIssue ? repairedIssues.findIndex((issue) => issue.id === detailIssue.id) : -1;
    const hoveredIssue = repairedIssues.find((issue) => issue.id === hoveredIssueId) || null;
    const overlayIssues = visibleState.status === "running" ? [] : (view === "detail" ? detailIssue : hoveredIssue) ? [view === "detail" ? detailIssue : hoveredIssue] : [];
    const labelPlacements = layoutArtCritiqueLabels(overlayIssues);
    const issueNumberById = new Map(repairedIssues.map((issue, index) => [issue.id, index + 1]));

    const close = () => {
      abortRef.current?.abort();
      onClose();
    };

    const runReview = async (resume = false) => {
      if (abortRef.current) return;
      if (!node || !input) {
        setLocalError("请连接且仅连接一张已有图片");
        return;
      }
      if (resume && (!state.executionRunId || state.sourceFingerprint !== artCritiqueSourceFingerprint(input) || state.lastRunModel !== selectedCritiqueModel)) {
        setLocalError("原分析的图片或模型已变化，请开始新的分析");
        return;
      }
      setView("overview");
      setSelectedIssueId(null);
      setHoveredIssueId(null);
      setDraftReportVisible(false);
      const sourceFingerprint = artCritiqueSourceFingerprint(input);
      const runId = resume && state.lastRunId ? state.lastRunId : `art-critique-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let executionRunId = resume ? state.executionRunId : undefined;
      const controller = new AbortController();
      abortRef.current = controller;
      const runTarget = currentRunTargetRef.current;
      const runScope = host.utils?.getActiveUserScope?.() || "";
      const publishState = (next) => {
        if ((host.utils?.getActiveUserScope?.() || "") === runScope && currentRunTargetRef.current === runTarget && abortRef.current === controller) {
          onUpdateState(node.id, { ...next, executionRunId, lastRunModel: selectedCritiqueModel });
        }
      };
      const baseState = {
        ...state,
        schemaVersion: ART_CRITIQUE_SCHEMA_VERSION,
        status: "running",
        analysisStage: "preparing",
        sourceNodeId: input.id,
        sourceFingerprint,
        lastRunId: runId,
        stageTaskIds: resume ? state.stageTaskIds : {},
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: new Date().toISOString(),
      };
      publishState(baseState);
      setRunning(true);
      setActiveStage("preparing");
      setLocalError("");
      let latestStage = "preparing";
      let runningReport = state.report;
      const stageTaskIds = resume ? { ...state.stageTaskIds } : {};
      const runner = host.ai.createApprovedToolRunner({
        clientKey: `art-critique:${runId}`,
        runId: executionRunId,
        identity: { kind: "art-critique", nodeId: node.id, sourceFingerprint, model: selectedCritiqueModel },
        signal: controller.signal,
        onRun: (id) => {
          executionRunId = id;
          publishState({ ...baseState, stageTaskIds: { ...stageTaskIds } });
        },
      });
      try {
        const report = await executeArtCritique(host, {
          nodeId: node.id,
          runId,
          source: input,
          model: selectedCritiqueModel,
          signal: controller.signal,
          runner,
          onTaskCreated: (stage, taskId) => {
            stageTaskIds[stage] = taskId;
            publishState({ ...baseState, stageTaskIds: { ...stageTaskIds }, analysisStage: latestStage, updatedAt: new Date().toISOString() });
          },
          onStage: (analysisStage) => {
            latestStage = analysisStage;
            setActiveStage(analysisStage);
            publishState({
              ...baseState,
              stageTaskIds: { ...stageTaskIds },
              ...(runningReport ? { report: { ...runningReport, modelLabel: configuredCritiqueModelLabel } } : {}),
              analysisStage,
              updatedAt: new Date().toISOString(),
            });
          },
          onDraftReport: (draftReport) => {
            if (controller.signal.aborted || abortRef.current !== controller) return;
            runningReport = draftReport;
            setDraftReportVisible(true);
            publishState({
              ...baseState,
              stageTaskIds: { ...stageTaskIds },
              status: "running",
              analysisStage: latestStage,
              report: { ...draftReport, modelLabel: configuredCritiqueModelLabel },
              updatedAt: new Date().toISOString(),
            });
          },
        });
        setDraftReportVisible(false);
        publishState({
          ...baseState,
          stageTaskIds: { ...stageTaskIds },
          status: "completed",
          analysisStage: "completed",
          report: { ...report, modelLabel: configuredCritiqueModelLabel },
          updatedAt: new Date().toISOString(),
        });
        setActiveStage("completed");
      } catch (error) {
        if (controller.signal.aborted) {
          setActiveStage(undefined);
          setDraftReportVisible(false);
          publishState({ ...baseState, stageTaskIds: { ...stageTaskIds }, status: "failed", analysisStage: "failed", errorCode: "analysis_interrupted", errorMessage: "分析观察已停止；已提交阶段保留在任务中心，不会自动重复提交。", updatedAt: new Date().toISOString() });
          return;
        }
        const errorMessage = error instanceof Error ? error.message : "AI 批改失败，请稍后重试";
        setActiveStage("failed");
        setDraftReportVisible(false);
        setLocalError(errorMessage);
        publishState({ ...baseState, stageTaskIds: { ...stageTaskIds }, status: "failed", analysisStage: "failed", errorCode: error instanceof Error ? error.message : "art_critique_failed", errorMessage, updatedAt: new Date().toISOString() });
      } finally {
        runner.dispose?.();
        if (abortRef.current === controller) abortRef.current = null;
        setRunning(false);
      }
    };

    const progressStage = activeStage || visibleState.analysisStage || "preparing";
    const displayedModelLabel = visibleState.report?.modelLabel || configuredCritiqueModelLabel;
    const isDraft = draftReportVisible && visibleState.status === "running";
    const promptStatus = detailIssue ? (isDraft ? "pending" : detailIssue.editPrompt?.trim() ? "ready" : "unavailable") : "unavailable";

    const content = h(
      "div",
      {
        role: "dialog",
        "aria-label": "AI 审美批改",
        onPointerDown: (e) => e.stopPropagation(),
        onWheel: (e) => e.stopPropagation(),
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 1200,
          background: "rgba(0,0,0,0.62)",
          display: "grid",
          placeItems: "center",
          padding: 16,
        },
        onClick: (e) => {
          if (e.target === e.currentTarget) close();
        },
      },
      h(
        "div",
        {
          style: {
            width: "min(1180px, calc(100vw - 32px))",
            height: "min(800px, calc(100dvh - 32px))",
            background: theme.canvas.background,
            color: theme.node.text,
            borderRadius: "var(--r-lg, 12px)",
            border: `1px solid ${theme.node.edge}`,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
          },
        },
        h(
          "header",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 18px", borderBottom: `1px solid ${theme.node.edge}` } },
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: 15, fontWeight: 700 } }, "AI 审美批改"),
            h("div", { style: { fontSize: 12, color: theme.node.muted, marginTop: 2 } }, `${input?.title || "等待图片输入"} · 输入图片，输出批改报告，不修改原图`),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("span", { style: { fontSize: 12, color: theme.node.muted } }, running ? artCritiqueStageLabel(visibleState.analysisStage) : visibleState.status === "completed" && !stale ? "分析完成" : visibleState.status === "stale" ? "需要更新" : visibleState.status === "failed" ? "分析失败" : "尚未分析"),
            h("button", { type: "button", onClick: close, style: smallBtnStyle(theme, false) }, "关闭"),
          ),
        ),
        h(
          "div",
          { style: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(340px, 0.9fr)" } },
          h(
            "section",
            { style: { display: "flex", flexDirection: "column", gap: 10, padding: 16, borderRight: `1px solid ${theme.node.edge}`, minHeight: 0 } },
            h(
              "div",
              { style: { position: "relative", flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--r-lg, 10px)", border: `1px solid ${theme.node.edge}`, background: "rgba(0,0,0,0.18)", padding: 12, overflow: "hidden" } },
              previewUrl
                ? h("img", { src: previewUrl, alt: input?.title || "输入图片", draggable: false, style: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 } })
                : h("div", { style: { fontSize: 13, color: theme.node.muted } }, input ? "正在加载图片…" : "还没有图片输入"),
              overlayIssues.length && previewUrl && h(CritiqueOverlay, {
                issues: overlayIssues,
                issueNumberById,
                labelPlacements,
                onSelect: (id) => { setSelectedIssueId(id); setHoveredIssueId(null); setView("detail"); },
              }),
            ),
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: theme.node.muted } },
              h("span", null, isDraft ? "报告初稿已出，矩形标注将在定位复核完成后显示" : view === "detail" && detailIssue ? "当前只显示此问题的定位框" : input ? "悬停查看问题位置，点击问题进入详情" : "请从图片节点连接一条输入"),
              visibleState.report?.issues?.length ? h("span", null, view === "detail" && detailIndex >= 0 ? `问题 ${detailIndex + 1} / ${repairedIssues.length}` : `${visibleState.report.issues.length} 个问题`) : null,
            ),
          ),
          h(
            "aside",
            { style: { display: "flex", flexDirection: "column", minHeight: 0 } },
            h(
              "div",
              { style: { flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 } },
              (running || visibleState.status === "running") && h(
                "div",
                { style: { padding: 12, borderRadius: 10, border: `1px solid ${theme.node.edge}`, background: theme.node.panel } },
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 } },
                  h("span", null, artCritiqueStageLabel(progressStage)),
                  h("span", null, `${STAGE_PROGRESS[progressStage] || 10}%`),
                ),
                h("div", { style: { marginTop: 8, height: 6, borderRadius: 999, background: "rgba(148,163,184,0.2)", overflow: "hidden" } },
                  h("div", { style: { width: `${STAGE_PROGRESS[progressStage] || 10}%`, height: "100%", background: theme.accent.primary } }),
                ),
              ),
              (localError || visibleState.errorMessage) && h(
                "div",
                { role: "alert", style: { padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.09)", color: "var(--status-error, #ef4444)", fontSize: 12 } },
                localError || visibleState.errorMessage,
              ),
              view === "detail" && detailIssue
                ? h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 12 } },
                    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                      h("button", { type: "button", onClick: () => { setView("overview"); setSelectedIssueId(null); }, style: smallBtnStyle(theme, false) }, "← 问题列表"),
                      h("span", { style: { fontSize: 12, color: theme.node.muted } }, `问题 ${detailIndex + 1} / ${repairedIssues.length}`),
                    ),
                    h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 700 } }, detailIssue.title),
                    h("div", { style: { display: "flex", gap: 8, fontSize: 12, color: theme.node.muted } },
                      h("span", { style: { color: ART_CRITIQUE_CATEGORY_COLORS[detailIssue.category] } }, artCritiqueCategoryLabel(detailIssue.category)),
                      h("span", { style: { color: ART_CRITIQUE_SEVERITY_COLORS[detailIssue.severity] } }, artCritiqueSeverityLabel(detailIssue.severity)),
                      h("span", null, `${Math.round(detailIssue.confidence * 100)}% 把握`),
                    ),
                    h("div", { style: { padding: 12, borderRadius: 8, background: theme.node.panel, fontSize: 13, lineHeight: 1.6 } }, detailIssue.explanation),
                    detailIssue.targetDescription && h("div", { style: { fontSize: 12, color: theme.node.muted } }, `定位参考：${detailIssue.targetDescription}`),
                    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 } },
                      h("strong", { style: { fontSize: 13 } }, "改进建议"),
                      promptStatus === "ready"
                        ? h("button", { type: "button", onClick: () => void host.utils?.copyText?.(detailIssue.editPrompt || "", "AI 修改提示词已复制"), style: smallBtnStyle(theme, true) }, "复制提示词")
                        : h("span", { style: { fontSize: 12, color: theme.node.muted } }, promptStatus === "pending" ? "AI 生成中…" : "提示词未生成"),
                    ),
                    h("div", { style: { fontSize: 13, lineHeight: 1.6 } }, `目标：${detailIssue.suggestion.goal}`),
                    detailIssue.suggestion.actions?.length > 0 && h("ol", { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 } },
                      detailIssue.suggestion.actions.map((action) => h("li", { key: action }, action)),
                    ),
                    detailIssue.suggestion.preserve?.length > 0 && h("div", { style: { padding: 10, borderRadius: 8, background: "rgba(34,197,94,0.08)", fontSize: 12 } },
                      h("div", { style: { fontWeight: 600, color: "var(--status-success, #22c55e)", marginBottom: 4 } }, "需要保留"),
                      detailIssue.suggestion.preserve.map((p) => h("div", { key: p }, `• ${p}`)),
                    ),
                    h("div", { style: { padding: 10, borderRadius: 8, border: `1px solid ${theme.node.edge}`, fontSize: 12 } }, `预期效果：${detailIssue.suggestion.expectedEffect}`),
                  )
                : h(
                    React.Fragment,
                    null,
                    visibleState.report
                      ? h("section", { style: { borderBottom: `1px solid ${theme.node.edge}`, paddingBottom: 12 } },
                          h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, isDraft ? "整体判断（初稿）" : "整体判断"),
                          h("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.6 } }, visibleState.report.summary || "暂无整体总结"),
                          visibleState.report.strengths?.length > 0 && h("ul", { style: { margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: theme.node.muted } },
                            visibleState.report.strengths.slice(0, 3).map((s) => h("li", { key: s }, s)),
                          ),
                        )
                      : h("div", { style: { padding: 32, textAlign: "center", fontSize: 13, color: theme.node.muted } }, "还没有批改报告"),
                    reportOptions.length > 0 && h("section", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                      h("div", { style: { fontSize: 13, fontWeight: 600 } }, "可选方向"),
                      reportOptions.map((option) => h("div", { key: option.id, style: { padding: 10, borderRadius: 8, border: `1px solid ${theme.node.edge}`, background: theme.node.fill, fontSize: 12 } },
                        h("div", { style: { fontWeight: 600 } }, option.title),
                        h("p", { style: { margin: "4px 0 0", color: theme.node.muted } }, option.explanation),
                      )),
                    ),
                    visibleState.report?.issues?.length > 0 && h("section", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, fontWeight: 600 } },
                        h("span", null, "重点问题"),
                        h("span", { style: { fontSize: 12, color: theme.node.muted } }, `${visibleIssues.length} / ${visibleState.report.issues.length}`),
                      ),
                      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
                        h("button", { type: "button", onClick: () => setFilter("all"), style: smallBtnStyle(theme, filter === "all") }, "全部"),
                        CATEGORIES.map((category) => h("button", { key: category, type: "button", onClick: () => setFilter(category), style: smallBtnStyle(theme, filter === category) }, artCritiqueCategoryLabel(category))),
                      ),
                      visibleIssues.map((issue, index) => h("button", {
                        key: issue.id,
                        type: "button",
                        onClick: () => { setSelectedIssueId(issue.id); setHoveredIssueId(null); setView("detail"); },
                        onMouseEnter: () => setHoveredIssueId(issue.id),
                        onMouseLeave: () => setHoveredIssueId(null),
                        style: {
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 12px",
                          borderRadius: 8,
                          border: `1px solid ${theme.node.edge}`,
                          background: theme.node.panel,
                          color: theme.node.text,
                          cursor: "pointer",
                          display: "flex",
                          gap: 10,
                          alignItems: "flex-start",
                        },
                      },
                        h("span", { style: { width: 22, height: 22, borderRadius: 6, background: ART_CRITIQUE_SEVERITY_COLORS[issue.severity], color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 } }, String(issueNumberById.get(issue.id) || index + 1)),
                        h("span", { style: { minWidth: 0, flex: 1 } },
                          h("span", { style: { display: "block", fontSize: 13, fontWeight: 600 } }, issue.title),
                          h("span", { style: { display: "block", fontSize: 11, color: theme.node.muted, marginTop: 3 } }, `${artCritiqueCategoryLabel(issue.category)} · ${artCritiqueSeverityLabel(issue.severity)} · ${Math.round(issue.confidence * 100)}%`),
                        ),
                      )),
                    ),
                  ),
            ),
            h(
              "footer",
              { style: { borderTop: `1px solid ${theme.node.edge}`, padding: "10px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 } },
              h("span", { style: { fontSize: 11, color: selectedCritiqueModel || visibleState.report?.modelLabel ? theme.node.muted : "var(--status-warning, #f59e0b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }, title: displayedModelLabel },
                selectedCritiqueModel || visibleState.report?.modelLabel ? displayedModelLabel : "请到设置中选择支持图片理解的文本模型",
              ),
              h("div", { style: { display: "flex", gap: 8, marginLeft: "auto" } },
                running && h("button", { type: "button", onClick: () => abortRef.current?.abort(), style: smallBtnStyle(theme, false) }, "取消分析"),
                !running && state.executionRunId && state.status !== "completed" && !stale && state.lastRunModel === selectedCritiqueModel &&
                  h("button", { type: "button", disabled: !input, onClick: () => void runReview(true), style: smallBtnStyle(theme, false) }, "继续上次分析"),
                h("button", { type: "button", disabled: running || !input || !selectedCritiqueModel, onClick: () => void runReview(), style: { ...smallBtnStyle(theme, true), opacity: running || !input || !selectedCritiqueModel ? 0.5 : 1 } }, visibleState.report ? "重新批改" : "开始批改"),
              ),
            ),
          ),
        ),
      ),
    );

    if (host.ReactDOM?.createPortal && typeof document !== "undefined" && document.body) {
      return host.ReactDOM.createPortal(content, document.body);
    }
    return content;
  };
}
