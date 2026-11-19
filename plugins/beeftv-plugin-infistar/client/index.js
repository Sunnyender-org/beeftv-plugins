// BeefTV 内置合作伙伴插件：无限星河 AI (Infistar) 多模态渠道（beeftv-plugin-infistar）
// 通过 app.settings 插槽与 BUILTIN_SERVICE_PRESET 提供一键 BYOK 配置面板，将无限星河 AI API Key 与预置协议模型一键同步至宿主「设置 -> 模型服务」。

import {
  DEFAULT_BASE_URL,
  INFISTAR_CHANNEL_ICON,
  INFISTAR_CHANNEL_ID,
  INFISTAR_CHANNEL_NAME,
  INFISTAR_KEYS_URL,
  INFISTAR_LOGO_SVG_SPEC,
  INFISTAR_PRESET_MODELS,
  INFISTAR_PROMO_TEXT,
  INFISTAR_PROVIDER_INTRO,
  INFISTAR_WEBSITE_URL,
  buildInfistarModelChannel,
  renderInfistarLogoSvg,
  upgradeInfistarModelProfile,
} from "./presets.js";

export {
  DEFAULT_BASE_URL,
  INFISTAR_CHANNEL_ICON,
  INFISTAR_CHANNEL_ID,
  INFISTAR_CHANNEL_NAME,
  INFISTAR_KEYS_URL,
  INFISTAR_LOGO_SVG_SPEC,
  INFISTAR_PRESET_MODELS,
  INFISTAR_PROMO_TEXT,
  INFISTAR_PROVIDER_INTRO,
  INFISTAR_WEBSITE_URL,
  buildInfistarModelChannel,
  renderInfistarLogoSvg,
  upgradeInfistarModelProfile,
};

function getReact(host) {
  if (host?.React) return host.React;
  if (host?.ui?.React) return host.ui.React;
  if (typeof window !== "undefined") {
    return window.__BEEFTV_REACT__ || window.React || null;
  }
  return null;
}

function capabilityBadgeStyle(capability) {
  if (capability === "text") {
    return {
      background: "rgba(59, 130, 246, 0.12)",
      color: "#2563eb",
      label: "文本",
    };
  }
  if (capability === "image") {
    return {
      background: "rgba(16, 185, 129, 0.12)",
      color: "#059669",
      label: "图片",
    };
  }
  return {
    background: "rgba(139, 92, 246, 0.12)",
    color: "#7c3aed",
    label: "视频",
  };
}

function createInfistarSettingsPanel(host) {
  const React = getReact(host);
  if (!React) return () => null;
  const h = React.createElement;

  return function InfistarSettingsPanel(props) {
    const existingChannel = React.useMemo(() => {
      try {
        const channels = host?.channels?.list?.() || [];
        return channels.find(
          (item) =>
            item.id === INFISTAR_CHANNEL_ID ||
            String(item.baseUrl || "").includes("infistar.cc") ||
            String(item.baseUrl || "").includes("infistar.ai"),
        );
      } catch {
        return undefined;
      }
    }, []);

    const initialApiKey =
      props?.config?.apiKey ||
      host?.config?.get?.("apiKey", "") ||
      existingChannel?.apiKey ||
      "";
    const initialBaseUrl =
      props?.config?.baseUrl ||
      host?.config?.get?.("baseUrl", "") ||
      existingChannel?.baseUrl ||
      DEFAULT_BASE_URL;

    const [apiKey, setApiKey] = React.useState(String(initialApiKey));
    const [baseUrl, setBaseUrl] = React.useState(String(initialBaseUrl));
    const [showKey, setShowKey] = React.useState(false);
    const [selectedModels, setSelectedModels] = React.useState(() =>
      existingChannel?.models?.length
        ? existingChannel.models
        : INFISTAR_PRESET_MODELS.map((item) => item.model),
    );
    const [catalogChecking, setCatalogChecking] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [onlineModels, setOnlineModels] = React.useState([]);
    const [synced, setSynced] = React.useState(
      Boolean(existingChannel?.hasApiKey || existingChannel?.apiKey),
    );
    const [statusMessage, setStatusMessage] = React.useState(
      existingChannel?.hasApiKey || existingChannel?.apiKey
        ? `已连接「${existingChannel.name}」渠道（已启用 ${existingChannel.models?.length || 0} 个模型）`
        : "",
    );
    const [errorMessage, setErrorMessage] = React.useState("");

    const toggleModel = (modelId) => {
      setSelectedModels((prev) =>
        prev.includes(modelId)
          ? prev.filter((item) => item !== modelId)
          : [...prev, modelId],
      );
    };

    const handleFetchCatalog = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || DEFAULT_BASE_URL;
      if (!trimmedKey) {
        setErrorMessage("请先填写无限星河 AI API Key");
        return;
      }
      setCatalogChecking(true);
      setErrorMessage("");
      try {
        let ids = [];
        if (typeof host?.channels?.fetchCatalog === "function") {
          const catalog = await host.channels.fetchCatalog({
            baseUrl: trimmedUrl,
            apiKey: trimmedKey,
            apiFormat: "openai",
          });
          ids = Array.isArray(catalog?.models) ? catalog.models : [];
        } else {
          const resp = await fetch("/api/ai/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseUrl: trimmedUrl,
              apiKey: trimmedKey,
              apiFormat: "openai",
            }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || (typeof data?.code === "number" && data.code !== 0)) {
            throw new Error(
              data?.msg || data?.error || `读取在线目录失败（HTTP ${resp.status}）`,
            );
          }
          const rawModels = Array.isArray(data?.data?.models)
            ? data.data.models
            : Array.isArray(data?.models)
              ? data.models
              : [];
          ids = rawModels
            .map((item) => (typeof item === "string" ? item : item?.id))
            .filter(Boolean);
        }
        setOnlineModels(ids);
        setStatusMessage(`在线目录验证成功：共发现 ${ids.length} 个上游模型`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "读取在线目录失败");
      } finally {
        setCatalogChecking(false);
      }
    };

    const handleSaveAndSync = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || DEFAULT_BASE_URL;
      const hasSavedKey = Boolean(existingChannel?.hasApiKey || existingChannel?.apiKey);
      if (!trimmedKey && !hasSavedKey) {
        setErrorMessage("请填写有效的无限星河 AI API Key（sk-...）");
        return;
      }
      if (!selectedModels.length) {
        setErrorMessage("请至少勾选 1 个要同步的模型");
        return;
      }
      setSaving(true);
      setErrorMessage("");
      try {
        const patch = trimmedKey ? { apiKey: trimmedKey, baseUrl: trimmedUrl } : { baseUrl: trimmedUrl };
        if (typeof props?.updateConfig === "function") {
          await props.updateConfig(patch);
        } else if (host?.config?.set) {
          await host.config.set(patch);
        }
        const channel = buildInfistarModelChannel({
          apiKey: trimmedKey,
          baseUrl: trimmedUrl,
          selectedModels,
          existingChannel,
        });
        if (!host?.channels?.upsert) {
          throw new Error("当前宿主版本不支持同步模型渠道");
        }
        await host.channels.upsert(channel);
        setSynced(true);
        setStatusMessage(
          `已将「${INFISTAR_CHANNEL_NAME}」与 ${channel.models.length} 个模型同步至「设置 -> 模型服务」！`,
        );
        host?.ui?.notify?.("无限星河 AI 渠道与模型已同步至模型服务", "success");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "保存并同步渠道失败");
      } finally {
        setSaving(false);
      }
    };

    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "4px 0",
        },
      },
      h(
        "div",
        {
          style: {
            borderRadius: "12px",
            border: "1px solid rgba(99, 102, 241, 0.25)",
            background:
              "linear-gradient(135deg, rgba(37, 99, 235, 0.08) 0%, rgba(139, 92, 246, 0.06) 100%)",
            padding: "14px 16px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "6px",
            },
          },
          h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontWeight: 600,
                fontSize: "14px",
              },
            },
            renderInfistarLogoSvg(h, {
              size: 20,
              "aria-hidden": true,
              style: { flexShrink: 0 },
            }),
            "无限星河 AI (Infistar) · BYOK 一键接入",
          ),
          h(
            "span",
            {
              style: {
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: "rgba(99, 102, 241, 0.14)",
                color: "#4f46e5",
                fontWeight: 600,
              },
            },
            "官方合作伙伴",
          ),
        ),
        h(
          "p",
          {
            style: {
              margin: "0 0 4px",
              fontSize: "12px",
              color: "var(--user-ink-muted, var(--muted-foreground))",
              lineHeight: 1.6,
            },
          },
          INFISTAR_PROVIDER_INTRO,
        ),
        h(
          "p",
          {
            style: {
              margin: 0,
              fontSize: "12px",
              color: "var(--user-ink-muted, var(--muted-foreground))",
              lineHeight: 1.6,
            },
          },
          `填写一个无限星河 AI API Key，即可一键启用 Claude、GPT、Gemini、DeepSeek、Seedream、GPT Image、Gemini Image、Seedance、MiniMax H3、Wan 与 Kling 共 ${INFISTAR_PRESET_MODELS.length} 款文本、图像与视频模型。`,
        ),
      ),

      h(
        "div",
        {
          style: {
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "12px",
          },
        },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "infistar-plugin-base-url",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "接口地址 (Base URL)",
          ),
          h("input", {
            id: "infistar-plugin-base-url",
            type: "text",
            value: baseUrl,
            onChange: (e) => setBaseUrl(e.target.value),
            placeholder: DEFAULT_BASE_URL,
            style: {
              width: "100%",
              padding: "8px 12px",
              borderRadius: "8px",
              border: "1px solid rgba(128,128,128,0.28)",
              background: "transparent",
              fontSize: "13px",
              fontFamily: "monospace",
            },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "infistar-plugin-api-key",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "无限星河 AI API Key",
          ),
          h(
            "div",
            { style: { display: "flex", gap: "8px" } },
            h("input", {
              id: "infistar-plugin-api-key",
              "aria-label": "无限星河 AI API Key",
              type: showKey ? "text" : "password",
              value: apiKey,
              onChange: (e) => setApiKey(e.target.value),
              placeholder: "sk-...",
              style: {
                flex: 1,
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(128,128,128,0.28)",
                background: "transparent",
                fontSize: "13px",
                fontFamily: "monospace",
              },
            }),
            h(
              "button",
              {
                type: "button",
                onClick: () => setShowKey((v) => !v),
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(128,128,128,0.28)",
                  background: "transparent",
                  fontSize: "12px",
                  cursor: "pointer",
                },
              },
              showKey ? "隐藏" : "显示",
            ),
            h(
              "button",
              {
                type: "button",
                disabled: catalogChecking,
                onClick: handleFetchCatalog,
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(99, 102, 241, 0.35)",
                  background: "rgba(99, 102, 241, 0.08)",
                  color: "#4f46e5",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: catalogChecking ? "wait" : "pointer",
                },
              },
              catalogChecking ? "验证中..." : "验证在线目录",
            ),
          ),
        ),
      ),

      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            },
          },
          h(
            "span",
            { style: { fontSize: "12px", fontWeight: 600 } },
            `预置协议模型（已选 ${selectedModels.length} / ${INFISTAR_PRESET_MODELS.length}）`,
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () =>
                setSelectedModels(
                  selectedModels.length === INFISTAR_PRESET_MODELS.length
                    ? []
                    : INFISTAR_PRESET_MODELS.map((item) => item.model),
                ),
              style: {
                border: "none",
                background: "transparent",
                color: "#4f46e5",
                fontSize: "12px",
                cursor: "pointer",
              },
            },
            selectedModels.length === INFISTAR_PRESET_MODELS.length ? "取消全选" : "全选模型",
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "8px",
            },
          },
          INFISTAR_PRESET_MODELS.map((item) => {
            const checked = selectedModels.includes(item.model);
            const isOnline =
              onlineModels.includes(item.model) ||
              onlineModels.some((m) =>
                String(m).toLowerCase().endsWith(item.model.toLowerCase()),
              );
            const badge = capabilityBadgeStyle(item.capability);
            return h(
              "label",
              {
                key: item.model,
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: checked
                    ? "1px solid rgba(99, 102, 241, 0.45)"
                    : "1px solid rgba(128, 128, 128, 0.2)",
                  background: checked ? "rgba(99, 102, 241, 0.05)" : "transparent",
                  cursor: "pointer",
                  fontSize: "12px",
                },
              },
              h("input", {
                type: "checkbox",
                checked,
                onChange: () => toggleModel(item.model),
                style: { marginTop: "3px" },
              }),
              h(
                "div",
                { style: { flex: 1, minWidth: 0 } },
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "4px",
                      fontWeight: 600,
                    },
                  },
                  h("span", null, item.displayName),
                  h(
                    "span",
                    {
                      style: {
                        fontSize: "10px",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: badge.background,
                        color: badge.color,
                      },
                    },
                    badge.label,
                  ),
                ),
                h(
                  "div",
                  {
                    style: {
                      fontSize: "11px",
                      opacity: 0.65,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  `${item.model} · ${item.endpoint}`,
                ),
                isOnline
                  ? h(
                      "div",
                      { style: { fontSize: "10px", color: "#059669", marginTop: "2px" } },
                      "● 上游目录已确认在线",
                    )
                  : null,
              ),
            );
          }),
        ),
      ),

      errorMessage
        ? h(
            "div",
            {
              role: "alert",
              style: {
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "#dc2626",
                fontSize: "12px",
              },
            },
            errorMessage,
          )
        : null,
      statusMessage
        ? h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                color: "#059669",
                fontSize: "12px",
              },
            },
            h("span", null, statusMessage),
            synced
              ? h(
                  "button",
                  {
                    type: "button",
                    onClick: () => host?.ui?.navigate?.("/settings?section=channels"),
                    style: {
                      padding: "4px 10px",
                      borderRadius: "6px",
                      border: "1px solid rgba(16, 185, 129, 0.4)",
                      background: "rgba(16, 185, 129, 0.12)",
                      color: "#047857",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    },
                  },
                  "前往模型服务查看与测试 →",
                )
              : null,
          )
        : null,

      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            paddingTop: "4px",
          },
        },
        h(
          "button",
          {
            type: "button",
            disabled: saving,
            onClick: handleSaveAndSync,
            style: {
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              background: "#4f46e5",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: saving ? "wait" : "pointer",
            },
          },
          saving ? "同步中..." : "一键保存并同步到模型服务",
        ),
      ),
    );
  };
}

export const BUILTIN_SERVICE_PRESET = {
  id: INFISTAR_CHANNEL_ID,
  name: INFISTAR_CHANNEL_NAME,
  subtitle: "Claude · GPT · Gemini · 多款图片与视频",
  icon: INFISTAR_CHANNEL_ICON,
  baseUrl: DEFAULT_BASE_URL,
  partner: true,
  keysUrl: INFISTAR_KEYS_URL,
  websiteUrl: INFISTAR_WEBSITE_URL,
  promoText: INFISTAR_PROMO_TEXT,
  protocolPrefixes: ["infistar-"],
  hosts: ["infistar.cc", "www.infistar.cc", "infistar.ai", "www.infistar.ai"],
  hostSuffixes: [".infistar.cc", ".infistar.ai"],
  candidates: { text: "chat-completion", image: "infistar-image", audio: "openai-audio" },
  models: INFISTAR_PRESET_MODELS,
  presetDescription: "文本、图像与视频",
  providerIntro: INFISTAR_PROVIDER_INTRO,
  declaresReferenceMediaTransport: true,
  buildChannel(args) {
    return buildInfistarModelChannel({
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      selectedModels: args.selectedModels,
      existingChannel: args.existingChannel,
    });
  },
  upgradeProfile(profile) {
    return upgradeInfistarModelProfile(profile);
  },
};

export function activate(host) {
  const SettingsPanel = createInfistarSettingsPanel(host);
  const dispose = host.contribute("app.settings", {
    id: "infistar-settings",
    label: "无限星河 AI 多模态渠道",
    component: SettingsPanel,
  });
  return () => {
    if (typeof dispose === "function") dispose();
  };
}

export default { activate, BUILTIN_SERVICE_PRESET };
