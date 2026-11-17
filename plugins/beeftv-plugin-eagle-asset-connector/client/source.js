export const EAGLE_PLUGIN_ID = "beeftv-plugin-eagle-asset-connector";
export const EAGLE_DEFAULT_BASE_URL = "http://127.0.0.1:41595";

const MAX_THUMBNAIL_CACHE = 240;
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const thumbnailObjectUrls = new Map();
const thumbnailInFlight = new Map();

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `eagle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizedApiBase(host) {
  return String(host.api?.baseURL?.() || "/api").replace(/\/+$/, "");
}

export function eagleItemThumbnailUrl(host, itemId, baseUrl) {
  return `${normalizedApiBase(host)}/plugins/${EAGLE_PLUGIN_ID}/items/${encodeURIComponent(itemId)}/thumbnail?baseUrl=${encodeURIComponent(baseUrl)}`;
}

export function eagleItemFileUrl(host, itemId, baseUrl) {
  return `${normalizedApiBase(host)}/plugins/${EAGLE_PLUGIN_ID}/items/${encodeURIComponent(itemId)}/file?baseUrl=${encodeURIComponent(baseUrl)}`;
}

export async function getEagleLibrary(host, baseUrl) {
  return host.api.get(`/plugins/${EAGLE_PLUGIN_ID}/library`, { baseUrl });
}

export async function listEagleItems(host, input) {
  return host.api.get(`/plugins/${EAGLE_PLUGIN_ID}/items`, {
    baseUrl: input.baseUrl,
    folderId: input.folderId || undefined,
    keyword: input.keyword || undefined,
    limit: input.limit,
    offset: input.offset,
  });
}

export async function downloadEagleThumbnail(host, itemId, baseUrl, signal) {
  return host.api.getBlob(`/plugins/${EAGLE_PLUGIN_ID}/items/${encodeURIComponent(itemId)}/thumbnail`, {
    params: { baseUrl },
    timeout: THUMBNAIL_TIMEOUT_MS,
    signal,
    fallbackError: "读取 Eagle 缩略图失败",
  });
}

export async function downloadEagleItem(host, itemId, baseUrl, signal) {
  return host.api.getBlob(`/plugins/${EAGLE_PLUGIN_ID}/items/${encodeURIComponent(itemId)}/file`, {
    params: { baseUrl },
    timeout: 0,
    signal,
    fallbackError: "读取 Eagle 素材失败",
  });
}

export async function saveEagleOriginalItem(host, baseUrl, item) {
  const fileName = eagleDownloadFileName(item);
  const saveEagle = typeof window !== "undefined" ? window.go?.main?.DesktopApp?.SaveEagleMedia : undefined;
  if (typeof saveEagle === "function") {
    const saved = await saveEagle(fileName, baseUrl, item.id);
    if (saved) host.ui?.notify?.("已保存", "success");
    return saved ? "saved" : "cancelled";
  }
  const blob = await downloadEagleItem(host, item.id, baseUrl);
  if (typeof host.media?.saveBlobToDisk === "function") {
    return host.media.saveBlobToDisk(fileName, blob);
  }
  if (typeof document !== "undefined" && typeof URL?.createObjectURL === "function") {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.click();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return "saved";
  }
  throw new Error("当前环境暂不支持下载原文件");
}

export async function addEagleItem(host, baseUrl, input) {
  return host.api.post(`/plugins/${EAGLE_PLUGIN_ID}/items?baseUrl=${encodeURIComponent(baseUrl)}`, input);
}

export async function createEagleFolder(host, baseUrl, input) {
  return host.api.post(`/plugins/${EAGLE_PLUGIN_ID}/folders?baseUrl=${encodeURIComponent(baseUrl)}`, input);
}

export function createEagleAssetSource(host, baseUrl = EAGLE_DEFAULT_BASE_URL) {
  let folderCache = null;
  let folderInflight = null;

  const getFolders = async (signal) => {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (folderCache) return folderCache;
    if (!folderInflight) {
      let requestPromise = null;
      requestPromise = getEagleLibrary(host, baseUrl)
        .then((response) => {
          const folders = response?.library?.folders || [];
          if (folderInflight === requestPromise) {
            folderCache = folders;
          }
          return folders;
        })
        .finally(() => {
          if (folderInflight === requestPromise) {
            folderInflight = null;
          }
        });
      folderInflight = requestPromise;
    }
    if (!signal) return folderInflight;
    const inflight = folderInflight;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("请求已取消", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      inflight.then(
        (folders) => {
          signal.removeEventListener("abort", onAbort);
          resolve(folders);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  return {
    listFolders: async (signal) =>
      (await getFolders(signal)).map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
      })),
    list: async (query = {}) => {
      const [result, folders] = await Promise.all([
        listEagleItems(host, {
          baseUrl,
          folderId: query.folderId,
          keyword: query.keyword,
          limit: query.limit,
          offset: query.offset,
        }),
        getFolders(query.signal),
      ]);
      const pathMap = buildFolderPathMap(folders);
      return (result?.items || []).map((item) => toExternalItem(host, item, baseUrl, pathMap));
    },
    importAsset: (item, signal) => importEagleAsset(host, item, baseUrl, signal),
    uploadAsset: (asset, signal) => uploadEagleAsset(host, asset, baseUrl, undefined, signal),
    uploadAssetToFolder: (asset, folderId, signal) => uploadEagleAsset(host, asset, baseUrl, folderId, signal),
    uploadFile: (file, folderId, signal) => uploadEagleFile(host, file, baseUrl, folderId, signal),
    createFolder: async (name, parentId) => {
      await createEagleFolder(host, baseUrl, { name, parentId });
      folderCache = null;
      folderInflight = null;
    },
  };
}

async function importEagleAsset(host, item, baseUrl, signal) {
  const kind = item.kind;
  if (kind === "text" || kind === "entity") {
    throw new Error("当前 Eagle 导入暂不支持文本或实体素材");
  }
  const blob = await downloadEagleItem(host, item.id, baseUrl, signal);
  const now = new Date().toISOString();
  const metadata = {
    source: "eagle",
    eagle: {
      itemId: item.id,
      baseUrl,
      folderId: item.folderId,
      folderIds: item.folderIds || [],
      folderPath: item.folderPath || [],
      extension: item.metadata?.extension,
    },
  };
  if (kind === "image") {
    const uploaded = await host.assets.uploadImageBlob(blob);
    return {
      id: randomId(),
      kind,
      title: item.title,
      coverUrl: uploaded.url,
      tags: item.tags || [],
      source: "Eagle 素材库",
      createdAt: now,
      updatedAt: now,
      metadata,
      data: {
        dataUrl: uploaded.url,
        storageKey: uploaded.storageKey,
        width: item.width || uploaded.width,
        height: item.height || uploaded.height,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
      },
    };
  }
  const uploaded = await host.assets.uploadMediaFileBlob(blob, `eagle-${kind}`);
  if (kind === "video") {
    return {
      id: randomId(),
      kind,
      title: item.title,
      coverUrl: "",
      tags: item.tags || [],
      source: "Eagle 素材库",
      createdAt: now,
      updatedAt: now,
      metadata,
      data: {
        url: uploaded.url,
        storageKey: uploaded.storageKey,
        width: item.width || uploaded.width || 1280,
        height: item.height || uploaded.height || 720,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
      },
    };
  }
  if (kind === "audio") {
    return {
      id: randomId(),
      kind,
      title: item.title,
      coverUrl: "",
      tags: item.tags || [],
      source: "Eagle 素材库",
      createdAt: now,
      updatedAt: now,
      metadata,
      data: {
        url: uploaded.url,
        storageKey: uploaded.storageKey,
        durationMs: uploaded.durationMs,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
      },
    };
  }
  return {
    id: randomId(),
    kind: "model",
    title: item.title,
    coverUrl: "",
    tags: item.tags || [],
    source: "Eagle 素材库",
    createdAt: now,
    updatedAt: now,
    metadata,
    data: {
      url: uploaded.url,
      storageKey: uploaded.storageKey,
      bytes: uploaded.bytes,
      mimeType: uploaded.mimeType,
      fileName: item.title,
    },
  };
}

function isEagleWritableAsset(asset) {
  return asset?.kind === "image" || asset?.kind === "video" || asset?.kind === "audio";
}

async function uploadEagleAsset(host, asset, baseUrl, folderId, signal) {
  if (!isEagleWritableAsset(asset)) {
    throw new Error("当前仅支持将图片、视频或音频写回 Eagle");
  }
  const dataUrl = await assetToDataUrl(host, asset, signal);
  const website =
    typeof asset.metadata?.eagle === "object" && asset.metadata.eagle && "url" in asset.metadata.eagle
      ? String(asset.metadata.eagle.url || "")
      : undefined;
  const result = await addEagleItem(host, baseUrl, {
    url: dataUrl,
    name: eagleAssetName(asset),
    folderId,
    tags: asset.tags,
    annotation: asset.note,
    website,
  });
  return {
    id: result?.item?.id || `eagle:${asset.id}`,
    title: eagleAssetName(asset),
    kind: asset.kind,
    tags: asset.tags,
    mimeType: asset.data.mimeType,
  };
}

async function assetToDataUrl(host, asset, signal) {
  if (asset.kind === "image") {
    return host.assets.imageToDataUrl({
      dataUrl: asset.data.dataUrl,
      storageKey: asset.data.storageKey,
      url: asset.data.dataUrl,
      name: asset.title,
      mimeType: asset.data.mimeType,
    });
  }
  const stored = asset.data.storageKey ? await host.media.getMediaBlob(asset.data.storageKey) : null;
  if (stored) {
    return fileToDataUrl(withMimeType(stored, asset.data.mimeType), signal);
  }
  const url = asset.data.url;
  if (!url) throw new Error("生成结果没有可写入 Eagle 的媒体地址");
  if (url.startsWith("data:")) return url;
  const blob = await fetchEagleWritableBlob(host, url, signal);
  return fileToDataUrl(withMimeType(blob, asset.data.mimeType), signal);
}

async function fetchEagleWritableBlob(host, url, signal) {
  const apiPath = host.api.resolveBackendApiPath?.(url);
  if (apiPath) {
    try {
      return await host.api.getBlob(apiPath, {
        timeout: 0,
        signal,
        fallbackError: "读取生成媒体失败，无法写入 Eagle",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error("读取生成媒体失败，无法写入 Eagle");
    }
  }
  return host.api.fetchBlob(url, { signal, fallbackError: "读取生成媒体失败，无法写入 Eagle" });
}

async function uploadEagleFile(host, file, baseUrl, folderId, signal) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("单个文件不能超过 96 MB");
  if (!isEagleMediaType(file.type)) throw new Error("Eagle 写入目前支持图片、视频和音频文件");
  const dataUrl = await fileToDataUrl(file, signal);
  const result = await addEagleItem(host, baseUrl, {
    url: dataUrl,
    name: file.name,
    folderId,
  });
  const itemId = result?.item?.id || `eagle:${randomId()}`;
  const extension = file.name.includes(".") ? file.name.split(".").pop() || "" : "";
  return {
    id: itemId,
    title: file.name,
    kind: kindFromExtension(extension),
    thumbnailUrl: result?.item?.id ? eagleItemThumbnailUrl(host, result.item.id, baseUrl) : undefined,
    fileUrl: result?.item?.id ? eagleItemFileUrl(host, result.item.id, baseUrl) : undefined,
    mimeType: file.type || mimeTypeFromExtension(extension),
    bytes: file.size,
    folderId,
    folderIds: folderId ? [folderId] : [],
    metadata: { extension },
  };
}

function eagleAssetName(asset) {
  const title =
    String(asset.title || "").trim() ||
    (asset.kind === "image" ? "生成图片" : asset.kind === "video" ? "生成视频" : "生成音频");
  if (/\.[a-z0-9]{2,8}$/i.test(title)) return title;
  const fallback = asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : "mp3";
  return `${title}.${extensionFromMime(asset.data?.mimeType || "", fallback)}`;
}

function extensionFromMime(mimeType, fallback) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  if (value.includes("webm")) return "webm";
  if (value.includes("quicktime")) return "mov";
  if (value.includes("wav")) return "wav";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4")) return "mp4";
  if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
  return fallback;
}

function withMimeType(blob, mimeType) {
  return mimeType && blob.type !== mimeType ? blob.slice(0, blob.size, mimeType) : blob;
}

function isEagleMediaType(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  return value.startsWith("image/") || value.startsWith("video/") || value.startsWith("audio/");
}

function fileToDataUrl(file, signal) {
  if (typeof FileReader === "undefined") {
    return (async () => {
      signal?.throwIfAborted?.();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal?.throwIfAborted?.();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
    })();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      reader.abort();
      cleanup();
      reject(new DOMException("请求已取消", "AbortError"));
    };
    reader.onload = () => {
      cleanup();
      if (typeof reader.result !== "string") {
        reject(new Error("无法读取待写入的文件"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error("无法读取待写入的文件"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(file);
  });
}

function toExternalItem(host, item, baseUrl, pathMap) {
  const folderIds = item.folderIds || [];
  const tags = item.tags || [];
  return {
    id: item.id,
    title: item.name,
    kind: kindFromExtension(item.extension),
    thumbnailUrl: eagleItemThumbnailUrl(host, item.id, baseUrl),
    fileUrl: eagleItemFileUrl(host, item.id, baseUrl),
    mimeType: mimeTypeFromExtension(item.extension),
    width: item.width,
    height: item.height,
    bytes: item.size,
    tags,
    folderId: folderIds[0],
    folderIds,
    folderPath: folderIds[0] ? pathMap.get(folderIds[0]) : [],
    description: item.annotation,
    metadata: {
      extension: item.extension,
      modificationTime: item.modificationTime,
      url: item.url,
      deleted: item.deleted,
    },
  };
}

export function buildFolderPathMap(folders) {
  const byId = new Map((folders || []).map((folder) => [folder.id, folder]));
  const result = new Map();
  for (const folder of folders || []) {
    const path = [];
    const seen = new Set();
    let current = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    result.set(folder.id, path);
  }
  return result;
}

export function externalFolderPath(folders, folderId) {
  const byId = new Map((folders || []).map((folder) => [folder.id, folder]));
  const result = [];
  const seen = new Set();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

export function eagleFolderOptions(folders) {
  const pathMap = buildFolderPathMap(folders);
  return (folders || [])
    .map((folder) => ({
      value: folder.id,
      label: (pathMap.get(folder.id) || [folder.name]).join(" / "),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

export function eagleDownloadFileName(item) {
  const leaf = String(item?.title || "").trim().split(/[\\/]+/).pop() || "";
  const sanitized = leaf
    .replace(/\.\.+/g, ".")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const title = sanitized || "eagle-asset";
  if (/\.[a-z0-9]{1,10}$/i.test(title)) return title;
  const rawExt = typeof item?.metadata?.extension === "string" ? item.metadata.extension.trim() : "";
  const ext = rawExt.replace(/[^a-z0-9]/gi, "").slice(0, 10);
  return ext ? `${title}.${ext}` : title;
}

export function kindFromExtension(extension) {
  const value = String(extension || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(value)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(value)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(value)) return "audio";
  return "model";
}

export function mimeTypeFromExtension(extension) {
  const value = String(extension || "").toLowerCase();
  if (["jpg", "jpeg"].includes(value)) return "image/jpeg";
  if (value === "png") return "image/png";
  if (value === "webp") return "image/webp";
  if (value === "gif") return "image/gif";
  if (value === "svg") return "image/svg+xml";
  if (value === "mp4") return "video/mp4";
  if (value === "webm") return "video/webm";
  if (value === "mp3") return "audio/mpeg";
  if (value === "wav") return "audio/wav";
  if (value === "glb") return "model/gltf-binary";
  return "application/octet-stream";
}

export function touchCachedEagleThumbnail(key) {
  const cached = thumbnailObjectUrls.get(key);
  if (!cached) return undefined;
  thumbnailObjectUrls.delete(key);
  thumbnailObjectUrls.set(key, cached);
  return cached;
}

export function evictCachedEagleThumbnail(itemId, baseUrl) {
  const key = `${baseUrl}::${itemId}`;
  const existing = thumbnailObjectUrls.get(key);
  if (!existing) return;
  thumbnailObjectUrls.delete(key);
  URL.revokeObjectURL(existing);
}

export function clearCachedEagleThumbnails() {
  for (const pending of thumbnailInFlight.values()) pending.controller.abort();
  thumbnailInFlight.clear();
  for (const objectUrl of thumbnailObjectUrls.values()) URL.revokeObjectURL(objectUrl);
  thumbnailObjectUrls.clear();
}

export function loadCachedEagleThumbnail(host, itemId, baseUrl, signal, fetcher) {
  if (signal?.aborted) return Promise.reject(new DOMException("请求已取消", "AbortError"));
  const key = `${baseUrl}::${itemId}`;
  const cached = touchCachedEagleThumbnail(key);
  if (cached) return Promise.resolve(cached);

  const loadBlob = fetcher || ((id, url, abortSignal) => downloadEagleThumbnail(host, id, url, abortSignal));
  let entry = thumbnailInFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = loadBlob(itemId, baseUrl, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
        const existing = touchCachedEagleThumbnail(key);
        if (existing) return existing;
        const objectUrl = URL.createObjectURL(blob);
        thumbnailObjectUrls.set(key, objectUrl);
        while (thumbnailObjectUrls.size > MAX_THUMBNAIL_CACHE) {
          const oldestKey = thumbnailObjectUrls.keys().next().value;
          if (!oldestKey) break;
          const oldestUrl = thumbnailObjectUrls.get(oldestKey);
          thumbnailObjectUrls.delete(oldestKey);
          if (oldestUrl) URL.revokeObjectURL(oldestUrl);
        }
        return objectUrl;
      })
      .finally(() => {
        if (thumbnailInFlight.get(key)?.controller === controller) thumbnailInFlight.delete(key);
      });
    void promise.catch(() => undefined);
    entry = { controller, consumers: 0, promise };
    thumbnailInFlight.set(key, entry);
  }
  entry.consumers += 1;
  if (!signal) return entry.promise;
  const activeEntry = entry;
  return new Promise((resolve, reject) => {
    let released = false;
    const onAbort = () => {
      if (released) return;
      released = true;
      activeEntry.consumers = Math.max(0, activeEntry.consumers - 1);
      if (activeEntry.consumers === 0) {
        activeEntry.controller.abort();
        if (thumbnailInFlight.get(key) === activeEntry) thumbnailInFlight.delete(key);
      }
      reject(new DOMException("请求已取消", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    activeEntry.promise.then(
      (objectUrl) => {
        signal.removeEventListener("abort", onAbort);
        if (!released) resolve(objectUrl);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!released) reject(error);
      },
    );
  });
}
