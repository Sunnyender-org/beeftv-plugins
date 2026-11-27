// BeefTV plugin: a HaryAI API key in, every HaryAI model out in
// 设置 → 模型服务, as one channel.

import { CHANNEL_ID, buildChannel, loadModels } from "./profiles.js";

const KEYS_URL = "https://haryai.com/zh/dashboard";

export function activate(host) {
  const React = host.React;
  const h = React.createElement;

  function Settings() {
    const existing = React.useMemo(() => {
      try {
        return (host.channels?.list?.() || []).find((c) => c.id === CHANNEL_ID);
      } catch {
        return undefined;
      }
    }, []);
    const [apiKey, setApiKey] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(
      existing?.hasApiKey ? `已连接，${existing.models?.length || 0} 个模型` : "",
    );
    const [error, setError] = React.useState("");

    const sync = async () => {
      const key = apiKey.trim();
      if (!key && !existing?.hasApiKey) {
        setError("请填写 HaryAI API Key");
        return;
      }
      setBusy(true);
      setError("");
      try {
        const models = await loadModels();
        const channel = buildChannel({ apiKey: key, models, existing });
        if (!key) {
          // Re-sync with the key already saved.
          delete channel.apiKey;
          channel.hasApiKey = true;
        }
        await host.channels.upsert(channel);
        setApiKey("");
        setStatus(`已同步 ${channel.models.length} 个模型到「设置 → 模型服务」的 HaryAI 渠道`);
        host.ui?.notify?.("HaryAI 模型已同步", "success");
      } catch (err) {
        setError(err instanceof Error ? err.message : "同步失败");
      } finally {
        setBusy(false);
      }
    };

    const input = {
      type: "password",
      value: apiKey,
      placeholder: existing?.hasApiKey ? "已保存，换 Key 时再填" : "sk-...",
      autoComplete: "off",
      onChange: (e) => setApiKey(e.target.value),
      style: { padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.35)", background: "transparent", color: "inherit" },
    };
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0", fontSize: 13 } },
      h("label", { style: { fontWeight: 500 } }, "HaryAI API Key"),
      h("input", input),
      h(
        "a",
        { href: KEYS_URL, target: "_blank", rel: "noreferrer", style: { fontSize: 12, opacity: 0.75 } },
        "在 HaryAI 账户页获取 API Key",
      ),
      h(
        "button",
        {
          type: "button",
          disabled: busy,
          onClick: sync,
          style: { alignSelf: "flex-start", padding: "7px 14px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: busy ? "wait" : "pointer" },
        },
        busy ? "同步中…" : "保存并同步模型",
      ),
      status ? h("div", { style: { fontSize: 12, opacity: 0.8 } }, status) : null,
      error ? h("div", { style: { fontSize: 12, color: "#dc2626" } }, error) : null,
    );
  }

  return host.contribute("app.settings", { id: "haryai-settings", title: "HaryAI", label: "HaryAI", render: Settings });
}

export default { activate };
