import {
  EAGLE_DEFAULT_BASE_URL,
  EAGLE_PLUGIN_ID,
  eagleFolderOptions,
  getEagleLibrary,
} from "./source.js";

const buttonStyle = (primary = false) => ({
  height: 34,
  padding: "0 14px",
  borderRadius: "var(--r-md, 8px)",
  border: primary ? "none" : "1px solid var(--border-subtle, rgba(148,163,184,0.3))",
  background: primary ? "var(--workspace-accent, #2563eb)" : "var(--surface-primary, transparent)",
  color: primary ? "#fff" : "var(--user-ink, inherit)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  textDecoration: "none",
});

const inputStyle = {
  width: "100%",
  height: 36,
  padding: "0 10px",
  borderRadius: "var(--r-md, 8px)",
  border: "1px solid var(--border-subtle, rgba(148,163,184,0.3))",
  background: "var(--surface-primary, transparent)",
  color: "var(--user-ink, inherit)",
  fontSize: 13,
  boxSizing: "border-box",
};

export function createEagleSettingsPanel(host) {
  const React = host.React;
  const h = React.createElement;

  return function EaglePluginSettingsPanel(props) {
    const { pluginId = EAGLE_PLUGIN_ID, config = {}, updateConfig } = props || {};
    const brandName = host.utils?.getBrandName?.() || "创作工作台";
    const [baseUrl, setBaseUrl] = React.useState(
      typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl : EAGLE_DEFAULT_BASE_URL,
    );
    const [generatedFolderId, setGeneratedFolderId] = React.useState(
      typeof config.generatedFolderId === "string" ? config.generatedFolderId : "",
    );
    const [folders, setFolders] = React.useState([]);
    const [loadingFolders, setLoadingFolders] = React.useState(false);
    const [foldersError, setFoldersError] = React.useState("");
    const [saving, setSaving] = React.useState(false);

    const loadFolders = async () => {
      setLoadingFolders(true);
      setFoldersError("");
      try {
        const result = await getEagleLibrary(host, baseUrl.trim().replace(/\/$/, ""));
        setFolders(result?.library?.folders || []);
      } catch (reason) {
        setFoldersError(reason instanceof Error ? reason.message : "读取 Eagle 文件夹失败");
        setFolders([]);
      } finally {
        setLoadingFolders(false);
      }
    };

    const saveConfig = async () => {
      const normalized = baseUrl.trim().replace(/\/$/, "");
      if (!/^https?:\/\//i.test(normalized)) {
        host.ui?.notify?.("Eagle 地址必须以 http:// 或 https:// 开头", "error");
        return;
      }
      setSaving(true);
      try {
        await updateConfig?.({
          baseUrl: normalized,
          generatedFolderId,
        });
        host.ui?.notify?.("Eagle 插件配置已保存", "success");
      } catch (reason) {
        host.ui?.notify?.(reason instanceof Error ? reason.message : "保存 Eagle 配置失败", "error");
      } finally {
        setSaving(false);
      }
    };

    const options = eagleFolderOptions(folders);
    const muted = "var(--user-ink-muted, rgba(148,163,184,0.85))";

    return h(
      "div",
      {
        "data-testid": `eagle-settings-${pluginId}`,
        style: { display: "flex", flexDirection: "column", gap: 16, color: "var(--user-ink, inherit)" },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h("label", { htmlFor: "eagle-base-url", style: { fontSize: 13, fontWeight: 600 } }, "Eagle 本地 API 地址"),
        h("input", {
          id: "eagle-base-url",
          "aria-label": "Eagle 本地 API 地址",
          value: baseUrl,
          placeholder: "http://127.0.0.1:41595",
          onChange: (event) => setBaseUrl(event.target.value),
          style: inputStyle,
        }),
        h("p", { style: { margin: 0, fontSize: 12, color: muted } }, `Eagle 必须在本机运行；${brandName}通过插件直接读取和写入 Eagle 原始文件。`),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
          h("label", { htmlFor: "eagle-generated-folder", style: { fontSize: 13, fontWeight: 600 } }, "默认写入文件夹"),
          h(
            "button",
            {
              type: "button",
              onClick: () => void loadFolders(),
              disabled: loadingFolders,
              style: {
                border: "none",
                background: "transparent",
                color: "var(--workspace-accent, #2563eb)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                padding: 0,
              },
            },
            loadingFolders ? "读取中…" : "读取文件夹",
          ),
        ),
        h(
          "select",
          {
            id: "eagle-generated-folder",
            "aria-label": "默认写入文件夹",
            value: generatedFolderId,
            onChange: (event) => setGeneratedFolderId(event.target.value),
            style: inputStyle,
          },
          h("option", { value: "" }, "Eagle 根目录"),
          options.map((opt) => h("option", { key: opt.value, value: opt.value }, opt.label)),
        ),
        h(
          "p",
          { style: { margin: 0, fontSize: 12, color: foldersError ? "var(--status-error, #ef4444)" : muted } },
          foldersError || "在 Eagle 素材库未选定具体目录时，手动写入素材默认归档到此文件夹（留空则写入根目录）。",
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 4 } },
        h(
          "button",
          { type: "button", disabled: saving, onClick: () => void saveConfig(), style: buttonStyle(true) },
          saving ? "保存中…" : "保存配置",
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => host.ui?.navigate?.(`/p/${EAGLE_PLUGIN_ID}`),
            style: buttonStyle(false),
          },
          "打开 Eagle 素材库",
        ),
        h(
          "a",
          {
            href: "https://api.eagle.cool/",
            target: "_blank",
            rel: "noreferrer",
            style: buttonStyle(false),
          },
          "查看 API",
        ),
      ),
    );
  };
}
