import {
  clearCachedEagleThumbnails,
  createEagleAssetSource,
  EAGLE_DEFAULT_BASE_URL,
  EAGLE_PLUGIN_ID,
  evictCachedEagleThumbnail,
  externalFolderPath,
  loadCachedEagleThumbnail,
  saveEagleOriginalItem,
  touchCachedEagleThumbnail,
} from "./source.js";

const EAGLE_FETCH_BATCH = 200;

function assetKindLabel(kind) {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  if (kind === "model") return "模型";
  return "文件";
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDimensions(item) {
  if (item.width && item.height) return `${item.width} × ${item.height}`;
  return item.mimeType || assetKindLabel(item.kind);
}

const cardBtnStyle = (active) => ({
  border: "1px solid var(--border-subtle, rgba(148,163,184,0.24))",
  background: active ? "var(--workspace-accent-soft, rgba(37,99,235,0.12))" : "var(--surface-primary, rgba(148,163,184,0.06))",
  color: active ? "var(--workspace-accent, #2563eb)" : "var(--user-ink, inherit)",
  borderRadius: "var(--r-md, 8px)",
  cursor: "pointer",
  fontSize: 13,
});

const actionBtnStyle = (primary = false) => ({
  height: 34,
  padding: "0 12px",
  borderRadius: "var(--r-md, 8px)",
  border: primary ? "none" : "1px solid var(--border-subtle, rgba(148,163,184,0.28))",
  background: primary ? "var(--workspace-accent, #2563eb)" : "var(--surface-secondary, rgba(148,163,184,0.08))",
  color: primary ? "#fff" : "var(--user-ink, inherit)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
});

export function createEagleLibraryPage(host) {
  const React = host.React;
  const h = React.createElement;

  function EagleThumbnail({ itemId, baseUrl, enabled, refreshVersion, alt, maxHeight }) {
    const cacheKey = `${baseUrl}::${itemId}`;
    const [src, setSrc] = React.useState(() => (enabled ? touchCachedEagleThumbnail(cacheKey) || "" : ""));
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
      if (!enabled) {
        setSrc("");
        setFailed(false);
        return;
      }
      const cached = touchCachedEagleThumbnail(cacheKey);
      if (cached) {
        setSrc(cached);
        setFailed(false);
        return;
      }
      const controller = new AbortController();
      setSrc("");
      setFailed(false);
      void loadCachedEagleThumbnail(host, itemId, baseUrl, controller.signal)
        .then((objectUrl) => {
          if (!controller.signal.aborted) setSrc(objectUrl);
        })
        .catch((error) => {
          if (controller.signal.aborted || error?.name === "AbortError") return;
          setFailed(true);
        });
      return () => controller.abort();
    }, [baseUrl, cacheKey, enabled, itemId, refreshVersion]);

    if (!enabled || failed || !src) {
      return h("div", { style: { fontSize: 12, color: "var(--user-ink-muted, #94a3b8)" } }, "暂无预览");
    }
    return h("img", {
      src,
      alt,
      decoding: "async",
      style: {
        width: "100%",
        height: "100%",
        maxHeight: maxHeight || "100%",
        objectFit: "contain",
        display: "block",
      },
      onError: () => {
        evictCachedEagleThumbnail(itemId, baseUrl);
        setSrc("");
        setFailed(true);
      },
    });
  }

  function renderFolderTree(folders, selectedFolder, onSelect, parentId = "", depth = 0) {
    const children = folders.filter((folder) => (folder.parentId || "") === parentId);
    if (!children.length) return null;
    return children.map((folder) => {
      const active = selectedFolder === folder.id;
      return h(
        "div",
        { key: folder.id },
        h(
          "button",
          {
            type: "button",
            onClick: () => onSelect(folder.id),
            style: {
              ...cardBtnStyle(active),
              width: "100%",
              textAlign: "left",
              padding: `6px 8px 6px ${10 + depth * 12}px`,
              marginBottom: 4,
              border: "none",
              fontWeight: active ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            title: folder.name,
          },
          folder.name,
        ),
        renderFolderTree(folders, selectedFolder, onSelect, folder.id, depth + 1),
      );
    });
  }

  return function EagleLibraryPage() {
    const brandName = host.utils?.getBrandName?.() || "创作工作台";
    const configuredBaseUrl = host.config?.get?.("baseUrl", EAGLE_DEFAULT_BASE_URL);
    const baseUrl = typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()
      ? configuredBaseUrl.trim()
      : EAGLE_DEFAULT_BASE_URL;
    const provider = React.useMemo(() => createEagleAssetSource(host, baseUrl), [baseUrl]);
    const fileInputRef = React.useRef(null);
    const [folders, setFolders] = React.useState([]);
    const [items, setItems] = React.useState([]);
    const [selectedFolder, setSelectedFolder] = React.useState("");
    const [keyword, setKeyword] = React.useState("");
    const [folderName, setFolderName] = React.useState("");
    const [creatingFolder, setCreatingFolder] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(false);
    const [working, setWorking] = React.useState(false);
    const [error, setError] = React.useState("");
    const [progress, setProgress] = React.useState("");
    const [page, setPage] = React.useState(1);
    const pageSize = 40;
    const [previewItem, setPreviewItem] = React.useState(null);
    const [downloadingId, setDownloadingId] = React.useState(null);
    const [refreshVersion, setRefreshVersion] = React.useState(0);
    const loadSeqRef = React.useRef(0);

    React.useEffect(() => () => clearCachedEagleThumbnails(), [baseUrl]);

    const load = async (folderId = selectedFolder, search = keyword) => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setLoadingMore(false);
      setError("");
      setRefreshVersion((v) => v + 1);
      try {
        const [nextFolders, nextItems] = await Promise.all([
          provider.listFolders(),
          provider.list({ folderId: folderId || undefined, keyword: search.trim() || undefined, limit: EAGLE_FETCH_BATCH, offset: 0 }),
        ]);
        if (loadSeqRef.current !== seq) return;
        const list = nextItems || [];
        setFolders(nextFolders || []);
        setItems(list);
        setHasMore(list.length >= EAGLE_FETCH_BATCH);
        setPage(1);
      } catch (reason) {
        if (loadSeqRef.current !== seq) return;
        setError(reason instanceof Error ? reason.message : "连接 Eagle 失败，请确认 Eagle 已启动");
        setItems([]);
        setHasMore(false);
      } finally {
        if (loadSeqRef.current === seq) setLoading(false);
      }
    };

    const loadMore = async () => {
      if (loading || loadingMore || !hasMore) return;
      const seq = loadSeqRef.current;
      setLoadingMore(true);
      setError("");
      try {
        const nextItems = await provider.list({
          folderId: selectedFolder || undefined,
          keyword: keyword.trim() || undefined,
          limit: EAGLE_FETCH_BATCH,
          offset: items.length,
        });
        if (loadSeqRef.current !== seq) return;
        const batch = nextItems || [];
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...batch.filter((item) => !seen.has(item.id))];
        });
        setHasMore(batch.length >= EAGLE_FETCH_BATCH);
      } catch (reason) {
        if (loadSeqRef.current !== seq) return;
        setError(reason instanceof Error ? reason.message : "加载更多 Eagle 素材失败");
      } finally {
        if (loadSeqRef.current === seq) setLoadingMore(false);
      }
    };

    React.useEffect(() => {
      setSelectedFolder("");
      setKeyword("");
      void load("", "");
    }, [provider]);

    const handleFolderSelect = (nextFolder) => {
      const folderId = nextFolder === "root" ? "" : nextFolder;
      setSelectedFolder(folderId);
      setKeyword("");
      setPreviewItem(null);
      void load(folderId, "");
    };

    const handleCreateFolder = async () => {
      const name = folderName.trim();
      if (!name || creatingFolder) return;
      setCreatingFolder(true);
      setError("");
      try {
        await provider.createFolder(name, selectedFolder || undefined);
        setFolderName("");
        host.ui?.notify?.("已新建 Eagle 文件夹", "success");
        await load();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "新建 Eagle 文件夹失败");
      } finally {
        setCreatingFolder(false);
      }
    };

    const handleDownloadItem = async (item) => {
      if (downloadingId) return;
      setDownloadingId(item.id);
      try {
        await saveEagleOriginalItem(host, baseUrl, item);
      } catch (reason) {
        host.ui?.notify?.(reason instanceof Error && reason.message.trim() ? reason.message : "下载 Eagle 原文件失败", "error");
      } finally {
        setDownloadingId((current) => (current === item.id ? null : current));
      }
    };

    const handleUpload = async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (!files.length || working) return;
      const fallbackFolderId = String(host.config?.get?.("generatedFolderId", "") || "").trim();
      const targetFolderId = selectedFolder || fallbackFolderId || undefined;
      setWorking(true);
      setError("");
      let uploaded = 0;
      try {
        for (const [index, file] of files.entries()) {
          setProgress(`正在写入 ${index + 1}/${files.length}：${file.name}`);
          await provider.uploadFile(file, targetFolderId);
          uploaded += 1;
        }
        host.ui?.notify?.(`已写入 Eagle ${uploaded} 个文件`, "success");
        await load();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "写入 Eagle 失败");
        if (uploaded) host.ui?.notify?.(`已写入 ${uploaded} 个文件，剩余文件未完成`, "warning");
      } finally {
        setProgress("");
        setWorking(false);
      }
    };

    const folderPath = externalFolderPath(folders, selectedFolder);
    const currentFolder = folders.find((f) => f.id === selectedFolder);
    const visibleItems = items.slice((page - 1) * pageSize, page * pageSize);
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const totalBytes = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
    const muted = "var(--user-ink-muted, rgba(148,163,184,0.85))";
    const borderColor = "var(--border-subtle, rgba(148,163,184,0.22))";

    return h(
      "div",
      {
        "data-testid": `plugin-page-${EAGLE_PLUGIN_ID}`,
        style: {
          padding: 24,
          color: "var(--user-ink, inherit)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          minHeight: "100%",
        },
      },
      h(
        "header",
        { style: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 12 } },
        h(
          "div",
          null,
          h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("h1", { style: { margin: 0, fontSize: 22, fontWeight: 700 } }, "Eagle 素材库"),
            h("span", { style: { fontSize: 12, color: error ? "var(--status-error, #ef4444)" : muted } }, error ? "Eagle · 连接异常" : "Eagle · 已连接"),
          ),
          h("p", { style: { margin: "6px 0 0", fontSize: 13, color: muted } },
            `Eagle 是${brandName}的外部素材来源；直接读取和写入 Eagle 原始文件。`,
          ),
        ),
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
          h("button", { type: "button", disabled: working, onClick: () => fileInputRef.current?.click(), style: actionBtnStyle(true) }, working ? (progress || "写入中…") : "写入素材"),
          h("button", { type: "button", onClick: () => host.ui?.navigate?.("/assets"), style: actionBtnStyle(false) }, `${brandName}素材库`),
          h("button", { type: "button", onClick: () => host.ui?.navigate?.("/plugins"), style: actionBtnStyle(false) }, "插件设置"),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
        h("input", {
          value: keyword,
          placeholder: "搜索 Eagle 素材标题、标签或文件夹",
          onChange: (event) => {
            setPage(1);
            setKeyword(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key === "Enter") void load(selectedFolder, keyword);
          },
          style: {
            height: 36,
            padding: "0 12px",
            minWidth: 260,
            flex: "1 1 260px",
            maxWidth: 380,
            borderRadius: "var(--r-md, 8px)",
            border: `1px solid ${borderColor}`,
            background: "var(--surface-primary, transparent)",
            color: "inherit",
            fontSize: 13,
          },
        }),
        h("button", { type: "button", onClick: () => void load(selectedFolder, keyword), style: actionBtnStyle(false) }, "搜索"),
        h("button", { type: "button", onClick: () => { setKeyword(""); setPage(1); void load(selectedFolder, ""); }, style: actionBtnStyle(false) }, "刷新"),
      ),
      error && h(
        "div",
        { role: "alert", style: { padding: "10px 14px", borderRadius: "var(--r-md, 8px)", background: "rgba(239,68,68,0.12)", color: "var(--status-error, #ef4444)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13 } },
        h("span", null, error),
        h("button", { type: "button", onClick: () => void load(), style: actionBtnStyle(false) }, "重试"),
      ),
      h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "200px minmax(0, 1fr)", gap: 16, alignItems: "start" } },
        h(
          "aside",
          { style: { borderRight: `1px solid ${borderColor}`, paddingRight: 12, display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { fontSize: 12, fontWeight: 600, color: muted, marginBottom: 4 } }, "Eagle 文件夹"),
          h(
            "button",
            {
              type: "button",
              onClick: () => handleFolderSelect("root"),
              style: { ...cardBtnStyle(selectedFolder === ""), width: "100%", textAlign: "left", padding: "7px 10px", display: "flex", justifyContent: "space-between", fontWeight: 600 },
            },
            h("span", null, "全部素材"),
            h("span", { style: { fontSize: 12, opacity: 0.7 } }, items.length),
          ),
          folders.length ? renderFolderTree(folders, selectedFolder, handleFolderSelect) : h("div", { style: { fontSize: 12, color: muted, padding: "8px 4px" } }, "Eagle 中还没有文件夹"),
          h("button", { type: "button", onClick: () => setFolderName((v) => (v ? "" : "新文件夹")), style: { ...actionBtnStyle(false), width: "100%", justifyContent: "center", marginTop: 6 } }, "新建文件夹"),
        ),
        h(
          "section",
          { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 12 } },
          h(
            "nav",
            { "aria-label": "Eagle 文件夹路径", style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: muted } },
            h("button", { type: "button", onClick: () => handleFolderSelect("root"), style: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 0 } }, "Eagle 素材库"),
            folderPath.map((folder) =>
              h("span", { key: folder.id, style: { display: "inline-flex", alignItems: "center", gap: 6 } },
                "/",
                h("button", { type: "button", onClick: () => handleFolderSelect(folder.id), style: { border: "none", background: "transparent", color: "var(--user-ink, inherit)", fontWeight: 600, cursor: "pointer", padding: 0 } }, folder.name),
              ),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
            h("div", null,
              h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, `${currentFolder?.name || "全部素材"} (${items.length})`),
            ),
          ),
          folderName && h(
            "div",
            { style: { display: "flex", gap: 8, padding: 10, borderRadius: "var(--r-md, 8px)", background: "var(--surface-secondary, rgba(148,163,184,0.08))" } },
            h("input", {
              value: folderName,
              onChange: (event) => setFolderName(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") void handleCreateFolder(); },
              placeholder: "输入文件夹名称",
              style: { flex: 1, height: 32, padding: "0 10px", borderRadius: 6, border: `1px solid ${borderColor}`, background: "transparent", color: "inherit" },
            }),
            h("button", { type: "button", disabled: creatingFolder, onClick: () => void handleCreateFolder(), style: actionBtnStyle(true) }, "创建"),
            h("button", { type: "button", onClick: () => setFolderName(""), style: actionBtnStyle(false) }, "取消"),
          ),
          loading
            ? h("div", { style: { padding: 48, textAlign: "center", color: muted, fontSize: 13 } }, "读取 Eagle 文件…")
            : items.length
              ? h(
                  React.Fragment,
                  null,
                  h(
                    "div",
                    { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 } },
                    visibleItems.map((item) =>
                      h(
                        "div",
                        {
                          key: item.id,
                          style: {
                            borderRadius: "var(--r-lg, 12px)",
                            border: `1px solid ${previewItem?.id === item.id ? "var(--workspace-accent, #2563eb)" : borderColor}`,
                            background: "var(--surface-secondary, rgba(148,163,184,0.06))",
                            overflow: "hidden",
                            display: "flex",
                            flexDirection: "column",
                          },
                        },
                        h(
                          "button",
                          {
                            type: "button",
                            onClick: () => setPreviewItem(item),
                            style: { position: "relative", height: 148, border: "none", background: "rgba(0,0,0,0.06)", cursor: "pointer", padding: 0, display: "grid", placeItems: "center" },
                          },
                          h(EagleThumbnail, { itemId: item.id, baseUrl, enabled: Boolean(item.thumbnailUrl), refreshVersion, alt: item.title }),
                        ),
                        h(
                          "div",
                          { style: { padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 } },
                          h("div", { style: { display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" } },
                            h("span", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: item.title }, item.title),
                            h("span", { style: { fontSize: 11, color: muted, flexShrink: 0 } }, formatBytes(item.bytes || 0)),
                          ),
                          h("div", { style: { fontSize: 11, color: muted, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                            h("span", null, `${assetKindLabel(item.kind)} · ${formatDimensions(item)}`),
                            item.fileUrl && h("button", { type: "button", disabled: Boolean(downloadingId), onClick: () => void handleDownloadItem(item), style: { border: "none", background: "transparent", color: "var(--workspace-accent, #2563eb)", cursor: "pointer", fontSize: 11, padding: 0 } }, downloadingId === item.id ? "下载中" : "下载"),
                          ),
                        ),
                      ),
                    ),
                  ),
                  (totalPages > 1 || hasMore) && h(
                    "div",
                    { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, paddingTop: 8, fontSize: 12 } },
                    totalPages > 1 && h("button", { type: "button", disabled: page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)), style: actionBtnStyle(false) }, "上一页"),
                    totalPages > 1 && h("span", { style: { color: muted } }, `${page} / ${totalPages}`),
                    totalPages > 1 && h("button", { type: "button", disabled: page >= totalPages, onClick: () => setPage((p) => Math.min(totalPages, p + 1)), style: actionBtnStyle(false) }, "下一页"),
                    hasMore && h("button", { type: "button", disabled: loadingMore, onClick: () => void loadMore(), style: actionBtnStyle(false) }, loadingMore ? "加载中…" : "加载更多"),
                  ),
                )
              : h("div", { style: { padding: 48, textAlign: "center", color: muted, fontSize: 13 } }, "当前 Eagle 文件夹没有文件"),
        ),
      ),
      previewItem && h(
        "div",
        {
          role: "dialog",
          "aria-label": "素材档案",
          style: {
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: "min(420px, 100vw)",
            background: "var(--surface-primary, #0f172a)",
            borderLeft: `1px solid ${borderColor}`,
            padding: 20,
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            overflowY: "auto",
            boxShadow: "-12px 0 32px rgba(0,0,0,0.28)",
          },
        },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("strong", { style: { fontSize: 15 } }, previewItem.title),
          h("button", { type: "button", onClick: () => setPreviewItem(null), style: actionBtnStyle(false) }, "关闭"),
        ),
        h("div", { style: { height: 220, borderRadius: 10, background: "rgba(0,0,0,0.12)", display: "grid", placeItems: "center", overflow: "hidden" } },
          h(EagleThumbnail, { itemId: previewItem.id, baseUrl, enabled: Boolean(previewItem.thumbnailUrl), refreshVersion, alt: previewItem.title, maxHeight: 220 }),
        ),
        h("div", { style: { fontSize: 12, display: "flex", flexDirection: "column", gap: 6, color: muted } },
          h("div", null, `类型：${assetKindLabel(previewItem.kind)}`),
          h("div", null, `尺寸：${formatDimensions(previewItem)}`),
          h("div", null, `文件大小：${formatBytes(previewItem.bytes || 0)}`),
          h("div", null, `所在文件夹：${previewItem.folderPath?.join(" / ") || "Eagle 根目录"}`),
          h("div", null, `当前列表总大小：${formatBytes(totalBytes)}`),
          previewItem.description && h("p", { style: { margin: "6px 0 0", color: "var(--user-ink, inherit)" } }, previewItem.description),
        ),
        previewItem.fileUrl && h("button", { type: "button", disabled: Boolean(downloadingId), onClick: () => void handleDownloadItem(previewItem), style: actionBtnStyle(true) }, downloadingId === previewItem.id ? "正在下载…" : "下载 Eagle 原文件"),
      ),
      h("input", {
        ref: fileInputRef,
        type: "file",
        accept: "image/*,video/*,audio/*",
        multiple: true,
        style: { display: "none" },
        onChange: (event) => void handleUpload(event),
      }),
    );
  };
}
