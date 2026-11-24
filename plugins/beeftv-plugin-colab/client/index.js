// Google Colab 云端生图客户端面板：
// 注册「插件设置」面板（app.settings）与「画布侧栏」算力面板（canvas.sidePanel），
// 提供官方授权码跳转、计算单元余量与实时消耗查看、显卡档位选择、闲置自动关机时长及一键停机。

import {
  COLAB_MODELS,
  CONTROL_CLIENT_HEADER,
  CONTROL_SERVER_PORTS,
  DEFAULT_IDLE_STOP_MINUTES,
  PLUGIN_ID,
  buildGoogleAuthorizationUrl,
} from "../lib/constants.mjs";

export const buildClientGoogleAuthUrl = buildGoogleAuthorizationUrl;

const GPU_TIER_OPTIONS = [
  { value: "auto", label: "自动优选", hint: "优先 G4 96GB，满载时自动换 A100" },
  { value: "G4", label: "G4 · 96GB", hint: "满血跑原生 4K 与双语精绘" },
  { value: "A100", label: "A100 · 40GB", hint: "兼容全部四款生图与改图模型" },
  { value: "L4", label: "L4 · 24GB", hint: "低费率，仅支持 MOSS 系列" },
];

const IDLE_MINUTES_OPTIONS = [
  { value: 0, label: "用完即停", hint: "当前任务队列完成后立即释放云端显卡" },
  { value: 5, label: "5 分钟", hint: "闲置满 5 分钟自动释放云端显卡" },
  { value: 10, label: "10 分钟", hint: "闲置满 10 分钟自动释放云端显卡" },
  { value: DEFAULT_IDLE_STOP_MINUTES, label: "15 分钟", hint: "闲置满 15 分钟自动释放云端显卡" },
  { value: 30, label: "30 分钟", hint: "闲置满 30 分钟自动释放云端显卡" },
];

async function callLocalControl(pathname, { method = "GET", body, timeoutMs = 4000, ports = CONTROL_SERVER_PORTS } = {}) {
  let lastErr = null;
  for (const port of ports) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
          [CONTROL_CLIENT_HEADER]: "1",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => null);
      if (!json || json.service !== PLUGIN_ID) {
        continue;
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.message || `请求失败 (${res.status})`);
      }
      return { connected: true, port, data: json.data };
    } catch (err) {
      clearTimeout(timer);
      if (err?.message && !/fetch|abort|network|failed to fetch|load failed/i.test(err.message)) {
        throw err;
      }
      lastErr = err;
    }
  }
  return { connected: false, port: 0, data: null, error: lastErr };
}

function formatIdleCountdown(seconds) {
  const sec = Math.max(0, Number(seconds || 0));
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${String(s).padStart(2, "0")} 秒后自动关机` : `${s} 秒后自动关机`;
}

function createColabPanelComponent(host, { compact = false } = {}) {
  const React = host.React;
  const h = React.createElement;

  return function ColabComputePanel() {
    const [loading, setLoading] = React.useState(true);
    const [connected, setConnected] = React.useState(false);
    const [status, setStatus] = React.useState(null);
    const [busyAction, setBusyAction] = React.useState("");
    const [feedback, setFeedback] = React.useState(null);

    const refresh = React.useCallback(async (force = false) => {
      try {
        const res = await callLocalControl(`/api/status${force ? "?refresh=1" : ""}`, {
          timeoutMs: force ? 12000 : 4000,
        });
        setConnected(res.connected);
        if (res.connected) {
          setStatus(res.data);
        }
      } catch (err) {
        setFeedback({ kind: "error", text: err?.message || "读取状态失败" });
      } finally {
        setLoading(false);
      }
    }, []);

    React.useEffect(() => {
      void refresh(false);
      const timer = setInterval(() => {
        void refresh(false);
      }, 3500);
      return () => clearInterval(timer);
    }, [refresh]);

    const openAuthPage = () => {
      const url = status?.authUrl || buildClientGoogleAuthUrl();
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    };

    const updateSettings = async (patch) => {
      const wasActive = Boolean(status?.runtime?.active);
      setBusyAction("settings");
      setFeedback(null);
      try {
        const res = await callLocalControl("/api/settings", {
          method: "POST",
          body: patch,
          timeoutMs: patch.idleStopMinutes === 0 ? 15000 : 4000,
        });
        if (res.connected) {
          setStatus(res.data);
          if (patch.idleStopMinutes === 0 && wasActive && !res.data?.runtime?.active) {
            const verifiedZero = Boolean(res.data?.sessions?.verified && Number(res.data?.sessions?.count || 0) === 0);
            setFeedback({
              kind: "success",
              text: verifiedZero
                ? "已切换为用完即停，并释放当前闲置显卡（云端活跃会话为 0）。Colab 余额更新有延迟，此时已停计费。"
                : "已切换为用完即停，并已释放当前闲置显卡。",
            });
          }
        }
      } catch (err) {
        setFeedback({ kind: "error", text: err?.message || "更新设置失败" });
      } finally {
        setBusyAction("");
      }
    };

    const stopGpuNow = async (releaseAll = false) => {
      setBusyAction("stop");
      setFeedback(null);
      try {
        const res = await callLocalControl("/api/stop", {
          method: "POST",
          body: { releaseAll },
          timeoutMs: 15000,
        });
        if (res.connected) {
          setStatus(res.data);
          const verified = Boolean(res.data?.sessions?.verified);
          const remaining = Number(res.data?.sessions?.count || 0);
          if (verified && remaining === 0) {
            setFeedback({
              kind: "success",
              text: "已释放云端显卡，活跃会话已确认归零。Colab 余额结算通常有数十分钟延迟，此时已停止扣费。",
            });
          } else if (verified && remaining > 0) {
            setFeedback({
              kind: "warning",
              text: `当前显卡已释放，但账号下仍有 ${remaining} 个其他 Colab 会话运行中，可点上方按钮全部释放。`,
            });
          } else {
            setFeedback({
              kind: "success",
              text: "已发送释放指令。Colab 余额刷新有延迟，可点「刷新额度」确认活跃会话为 0。",
            });
          }
        }
      } catch (err) {
        setFeedback({ kind: "error", text: err?.message || "释放显卡失败" });
      } finally {
        setBusyAction("");
      }
    };

    const cardStyle = {
      background: "var(--card-surface, rgba(17,17,17,0.03))",
      boxShadow: "var(--elevation-hairline, inset 0 0 0 1px rgba(128,128,128,0.16))",
      borderRadius: "var(--r-lg, 12px)",
      padding: compact ? "var(--space-3, 12px)" : "var(--space-4, 16px)",
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-3, 12px)",
      color: "var(--foreground, inherit)",
      fontFamily: "var(--font-sans, system-ui, sans-serif)",
    };

    const raisedStyle = {
      background: "var(--card-surface-raised, rgba(128,128,128,0.08))",
      borderRadius: "var(--r-md, 8px)",
      padding: "var(--space-2-half, 10px) var(--space-3, 12px)",
    };

    const primaryBtnStyle = (disabled) => ({
      height: "34px",
      padding: "0 var(--space-3-half, 14px)",
      borderRadius: "var(--r-md, 8px)",
      border: "none",
      background: "var(--btn-solid-bg, #242426)",
      color: "var(--btn-solid-fg, #ffffff)",
      fontSize: "13px",
      fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
      whiteSpace: "nowrap",
    });

    const outlineBtnStyle = (disabled) => ({
      height: "34px",
      padding: "0 var(--space-3, 12px)",
      borderRadius: "var(--r-md, 8px)",
      border: "1px solid var(--btn-outline-border, rgba(128,128,128,0.28))",
      background: "transparent",
      color: "var(--foreground, inherit)",
      fontSize: "13px",
      fontWeight: 500,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
      whiteSpace: "nowrap",
    });

    const dangerBtnStyle = (disabled) => ({
      height: "34px",
      padding: "0 var(--space-3-half, 14px)",
      borderRadius: "var(--r-md, 8px)",
      border: "1px solid color-mix(in srgb, var(--palette-status-error, #dc2626) 42%, transparent)",
      background: "color-mix(in srgb, var(--palette-status-error, #dc2626) 10%, transparent)",
      color: "var(--palette-status-error, #dc2626)",
      fontSize: "13px",
      fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.55 : 1,
      whiteSpace: "nowrap",
    });

    if (loading) {
      return h(
        "div",
        { style: cardStyle },
        h(
          "div",
          { style: { fontSize: "var(--fs-caption, 12px)", opacity: 0.72 } },
          "正在读取 Colab 算力状态...",
        ),
      );
    }

    const runtimeActive = Boolean(status?.runtime?.active);
    const ccuBalance = status?.ccu ? Number(status.ccu.balance || 0).toFixed(2) : "--";
    const ccuRate = status?.ccu ? Number(status.ccu.hourlyRate || 0).toFixed(2) : "0.00";
    const verifiedSessions = Boolean(status?.sessions?.verified);
    const activeSessionCount = verifiedSessions
      ? Number(status.sessions.count || 0)
      : Number(status?.ccu?.assignmentsCount || 0);
    const otherSessionsRunning = !runtimeActive && activeSessionCount > 0;
    const idleStopMinutes = Number(status?.settings?.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES);
    const sessionAccelerators = Array.isArray(status?.sessions?.accelerators)
      ? status.sessions.accelerators.filter(Boolean)
      : [];
    const dl = status?.runtime?.downloadProgress;
    const dlPercent = dl && dl.total_bytes > 0
      ? Math.min(100, Math.round((dl.current_bytes / dl.total_bytes) * 100))
      : 0;

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "var(--space-3, 12px)" } },

      // 1. 算力仪表条
      h(
        "div",
        { style: cardStyle },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-2, 8px)",
              flexWrap: "wrap",
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "var(--space-2, 8px)" } },
            h("span", {
              style: {
                width: "8px",
                height: "8px",
                borderRadius: "var(--r-full, 9999px)",
                background: runtimeActive
                  ? "var(--palette-status-success, #16a34a)"
                  : otherSessionsRunning
                    ? "var(--palette-status-warning, #d97706)"
                    : "rgba(128,128,128,0.45)",
              },
            }),
            h(
              "span",
              { style: { fontSize: "var(--fs-body, 14px)", fontWeight: 600 } },
              runtimeActive
                ? `运行中 · ${status.runtime.accelerator}`
                : otherSessionsRunning
                  ? `账号下有 ${activeSessionCount} 个活跃会话`
                  : connected && status?.auth?.authorized
                    ? verifiedSessions && activeSessionCount === 0
                      ? "已停机 · 0 个活跃会话"
                      : "待机中 · 不计费"
                    : "Google Colab 云端算力",
            ),
          ),
          status?.auth?.email
            ? h(
                "span",
                {
                  style: {
                    fontSize: "var(--fs-label, 11px)",
                    opacity: 0.68,
                    fontFamily: "var(--font-mono, monospace)",
                  },
                },
                status.auth.email,
              )
            : null,
        ),

        // 数字读数区
        connected && status?.auth?.authorized
          ? h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--space-2, 8px)",
                },
              },
              h(
                "div",
                { style: raisedStyle },
                h("div", { style: { fontSize: "var(--fs-label, 11px)", opacity: 0.65 } }, "剩余计算单元"),
                h(
                  "div",
                  {
                    style: {
                      marginTop: "2px",
                      fontSize: "var(--fs-heading-lg, 18px)",
                      fontWeight: 700,
                      fontFamily: "var(--font-mono, monospace)",
                      fontVariantNumeric: "tabular-nums",
                    },
                  },
                  `${ccuBalance} CU`,
                ),
              ),
              h(
                "div",
                { style: raisedStyle },
                h("div", { style: { fontSize: "var(--fs-label, 11px)", opacity: 0.65 } }, "每小时消耗"),
                h(
                  "div",
                  {
                    style: {
                      marginTop: "2px",
                      fontSize: "var(--fs-heading-lg, 18px)",
                      fontWeight: 700,
                      fontFamily: "var(--font-mono, monospace)",
                      fontVariantNumeric: "tabular-nums",
                      color: Number(ccuRate) > 0 ? "var(--palette-status-warning, #d97706)" : "inherit",
                    },
                  },
                  `${ccuRate} CU/h`,
                ),
              ),
            )
          : null,

        // 云端活跃会话核对与扣费延迟提醒
        connected && status?.auth?.authorized
          ? h(
              "div",
              {
                style: {
                  fontSize: "var(--fs-caption, 12px)",
                  lineHeight: 1.5,
                  color: "var(--user-ink-muted, inherit)",
                },
              },
              verifiedSessions && activeSessionCount === 0
                ? "云端活跃会话：0（已确认停计费）。Colab 余额更新通常有数十分钟延迟，活跃会话归零即已停扣。"
                : verifiedSessions && activeSessionCount > 0
                  ? `云端活跃会话：${activeSessionCount} 个${sessionAccelerators.length ? `（${sessionAccelerators.join(" / ")}）` : ""}。挂机空转也会扣算力，余额更新可能有延迟。`
                  : "Colab 余额结算通常有数十分钟延迟，点「刷新额度」可实时核对云端活跃会话数。",
            )
          : null,

        // 实时阶段说明与下载进度条
        connected
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "var(--space-1-half, 6px)" } },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "var(--space-2, 8px)",
                    fontSize: "var(--fs-caption, 12px)",
                    lineHeight: 1.5,
                  },
                },
                h("span", null, status?.activeTask?.stageDetail || status?.runtime?.stageDetail || "待机中"),
                runtimeActive && (idleStopMinutes === 0 || status?.idleRemainingSeconds > 0)
                  ? h(
                      "span",
                      {
                        style: {
                          opacity: 0.68,
                          fontFamily: "var(--font-mono, monospace)",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        },
                      },
                      idleStopMinutes === 0
                        ? "任务结束立即释放"
                        : formatIdleCountdown(status.idleRemainingSeconds),
                    )
                  : null,
              ),
              dl
                ? h(
                    "div",
                    {
                      style: {
                        height: "6px",
                        borderRadius: "var(--r-full, 9999px)",
                        background: "rgba(128,128,128,0.18)",
                        overflow: "hidden",
                      },
                    },
                    h("div", {
                      style: {
                        width: `${dlPercent}%`,
                        height: "100%",
                        background: "var(--palette-status-loading, #2563eb)",
                        transition: "width 240ms ease",
                      },
                    }),
                  )
                : null,
            )
          : null,

        // 停机与刷新动作栏（统一 34px 高度）
        connected && status?.auth?.authorized
          ? h(
              "div",
              { style: { display: "flex", gap: "var(--space-2, 8px)", flexWrap: "wrap" } },
              runtimeActive
                ? h(
                    "button",
                    {
                      type: "button",
                      disabled: busyAction === "stop",
                      onClick: () => void stopGpuNow(false),
                      style: dangerBtnStyle(busyAction === "stop"),
                    },
                    busyAction === "stop" ? "释放中..." : "立即释放显卡（停止计费）",
                  )
                : otherSessionsRunning
                  ? h(
                      "button",
                      {
                        type: "button",
                        disabled: busyAction === "stop",
                        onClick: () => void stopGpuNow(true),
                        style: dangerBtnStyle(busyAction === "stop"),
                      },
                      busyAction === "stop" ? "释放中..." : "释放账号下运行中的会话",
                    )
                  : null,
              h(
                "button",
                {
                  type: "button",
                  disabled: Boolean(busyAction),
                  onClick: () => void refresh(true),
                  style: outlineBtnStyle(Boolean(busyAction)),
                },
                "刷新额度",
              ),
            )
          : null,
      ),

      // 2. 首次接入引导（凭证统一经由 BeefTV 模型服务安全保存）
      !connected || !status?.auth?.authorized
        ? h(
            "div",
            { style: cardStyle },
            h(
              "div",
              { style: { fontSize: "var(--fs-body, 14px)", fontWeight: 600 } },
              "用 Google AI 会员附赠算力在画布生图",
            ),
            h(
              "div",
              { style: { fontSize: "var(--fs-caption, 12px)", lineHeight: 1.6, color: "var(--user-ink-muted, inherit)" } },
              "Google AI Pro 每月送 200 CU（90 天滚动最多攒 600 CU），Ultra 送 1000～2000 CU，Colab 付费账号也适用。第 1 步：点「获取 Google 授权码」登录并复制授权码（已登录过 google-colab-cli 可自动复用）。第 2 步：在「模型服务」添加 Google Colab，粘贴到 API Key 一栏后点「读取模型」。",
            ),
            h(
              "div",
              { style: { display: "flex", gap: "var(--space-2, 8px)", flexWrap: "wrap" } },
              h(
                "button",
                {
                  type: "button",
                  onClick: openAuthPage,
                  style: primaryBtnStyle(false),
                },
                "获取 Google 授权码",
              ),
              h(
                "button",
                {
                  type: "button",
                  onClick: () => host?.ui?.navigate?.("/settings?section=channels"),
                  style: outlineBtnStyle(false),
                },
                "前往模型服务",
              ),
            ),
          )
        : null,

      // 3. 显卡档位与闲置关机偏好（桌面端本机服务就绪时可调）
      connected
        ? h(
            "div",
            { style: cardStyle },
            h(
              "div",
              { style: { fontSize: "var(--fs-caption, 12px)", fontWeight: 600 } },
              "显卡档位偏好",
            ),
            h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, minmax(0, 1fr))",
                  gap: "var(--space-1-half, 6px)",
                },
              },
              GPU_TIER_OPTIONS.map((opt) => {
                const active = (status?.settings?.gpuPreference || "auto") === opt.value;
                return h(
                  "button",
                  {
                    key: opt.value,
                    type: "button",
                    "aria-pressed": active,
                    title: opt.hint,
                    disabled: busyAction === "settings",
                    onClick: () => void updateSettings({ gpuPreference: opt.value }),
                    style: {
                      height: "32px",
                      padding: "0 var(--space-2, 8px)",
                      borderRadius: "var(--r-sm, 6px)",
                      border: active
                        ? "1px solid color-mix(in srgb, var(--palette-status-loading, #2563eb) 55%, transparent)"
                        : "1px solid var(--btn-outline-border, rgba(128,128,128,0.22))",
                      background: active
                        ? "color-mix(in srgb, var(--palette-status-loading, #2563eb) 11%, transparent)"
                        : "transparent",
                      color: "inherit",
                      fontSize: "var(--fs-caption, 12px)",
                      fontWeight: active ? 600 : 400,
                      cursor: "pointer",
                    },
                  },
                  opt.label,
                );
              }),
            ),
            h(
              "div",
              { style: { fontSize: "var(--fs-caption, 12px)", fontWeight: 600, marginTop: "var(--space-1, 4px)" } },
              "闲置自动关机时长",
            ),
            h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: compact ? "repeat(3, minmax(0, 1fr))" : "repeat(5, minmax(0, 1fr))",
                  gap: "var(--space-1-half, 6px)",
                },
              },
              IDLE_MINUTES_OPTIONS.map((opt) => {
                const active = idleStopMinutes === opt.value;
                return h(
                  "button",
                  {
                    key: opt.value,
                    type: "button",
                    "aria-pressed": active,
                    title: opt.hint,
                    disabled: busyAction === "settings",
                    onClick: () => void updateSettings({ idleStopMinutes: opt.value }),
                    style: {
                      height: "32px",
                      padding: "0 var(--space-2, 8px)",
                      borderRadius: "var(--r-sm, 6px)",
                      border: active
                        ? "1px solid color-mix(in srgb, var(--palette-status-loading, #2563eb) 55%, transparent)"
                        : "1px solid var(--btn-outline-border, rgba(128,128,128,0.22))",
                      background: active
                        ? "color-mix(in srgb, var(--palette-status-loading, #2563eb) 11%, transparent)"
                        : "transparent",
                      color: "inherit",
                      fontSize: "var(--fs-caption, 12px)",
                      fontWeight: active ? 600 : 400,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    },
                  },
                  opt.label,
                );
              }),
            ),
          )
        : null,

      // 4. 完整设置页展示支持模型速览（侧栏紧凑模式下省略）
      !compact
        ? h(
            "div",
            { style: cardStyle },
            h(
              "div",
              { style: { fontSize: "var(--fs-caption, 12px)", fontWeight: 600 } },
              "内置生图与改图模型",
            ),
            h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: "var(--space-2, 8px)",
                },
              },
              COLAB_MODELS.map((m) =>
                h(
                  "div",
                  { key: m.id, style: raisedStyle },
                  h("div", { style: { fontSize: "var(--fs-caption, 12px)", fontWeight: 600 } }, m.displayName),
                  h(
                    "div",
                    {
                      style: {
                        marginTop: "2px",
                        fontSize: "var(--fs-label, 11px)",
                        opacity: 0.65,
                        fontFamily: "var(--font-mono, monospace)",
                      },
                    },
                    m.id,
                  ),
                ),
              ),
            ),
          )
        : null,

      // 5. 操作反馈条
      feedback
        ? h(
            "div",
            {
              role: feedback.kind === "error" ? "alert" : "status",
              style: {
                padding: "var(--space-2-half, 10px) var(--space-3, 12px)",
                borderRadius: "var(--r-md, 8px)",
                fontSize: "var(--fs-caption, 12px)",
                lineHeight: 1.5,
                background:
                  feedback.kind === "error"
                    ? "color-mix(in srgb, var(--palette-status-error, #dc2626) 10%, transparent)"
                    : feedback.kind === "warning"
                      ? "color-mix(in srgb, var(--palette-status-warning, #d97706) 12%, transparent)"
                      : feedback.kind === "success"
                        ? "color-mix(in srgb, var(--palette-status-success, #16a34a) 10%, transparent)"
                        : "var(--card-surface-raised, rgba(128,128,128,0.08))",
                color:
                  feedback.kind === "error"
                    ? "var(--palette-status-error, #dc2626)"
                    : feedback.kind === "warning"
                      ? "var(--palette-status-warning, #d97706)"
                      : feedback.kind === "success"
                        ? "var(--palette-status-success, #16a34a)"
                        : "inherit",
              },
            },
            feedback.text,
          )
        : null,
    );
  };
}

export function activate(host) {
  const SettingsPanel = createColabPanelComponent(host, { compact: false });
  const SidePanel = createColabPanelComponent(host, { compact: true });

  const disposeSettings = host.contribute("app.settings", {
    id: "colab-settings",
    title: "Google Colab 云端生图",
    label: "Google Colab 云端生图",
    component: SettingsPanel,
  });

  const disposeSidePanel = host.contribute("canvas.sidePanel", {
    id: "colab-compute-sidepanel",
    title: "Colab 算力",
    component: SidePanel,
  });

  return () => {
    if (typeof disposeSettings === "function") disposeSettings();
    if (typeof disposeSidePanel === "function") disposeSidePanel();
  };
}

export default { activate };
