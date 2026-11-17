import { createEagleLibraryPage } from "./library-page.js";
import { createEagleSettingsPanel } from "./settings-panel.js";
import {
  createEagleAssetSource,
  EAGLE_DEFAULT_BASE_URL,
  EAGLE_PLUGIN_ID,
} from "./source.js";

export {
  clearCachedEagleThumbnails,
  createEagleAssetSource,
  EAGLE_DEFAULT_BASE_URL,
  EAGLE_PLUGIN_ID,
  eagleDownloadFileName,
  eagleFolderOptions,
  evictCachedEagleThumbnail,
  loadCachedEagleThumbnail,
  saveEagleOriginalItem,
} from "./source.js";

export function activate(host) {
  const getBaseUrl = () => {
    const value = host.config?.get?.("baseUrl", EAGLE_DEFAULT_BASE_URL);
    return typeof value === "string" && value.trim() ? value.trim() : EAGLE_DEFAULT_BASE_URL;
  };

  const LibraryPage = host.React ? createEagleLibraryPage(host) : () => null;
  const SettingsPanel = host.React ? createEagleSettingsPanel(host) : () => null;

  const disposePage = host.contribute("app.page", {
    path: "",
    title: "Eagle 素材库",
    component: LibraryPage,
  });

  const disposeSidebar = host.contribute("app.sidebar", {
    id: EAGLE_PLUGIN_ID,
    label: "Eagle 素材库",
    path: `/p/${EAGLE_PLUGIN_ID}`,
    order: 50,
  });

  const disposeSettings = host.contribute("app.settings", {
    title: "Eagle 素材库设置",
    component: SettingsPanel,
  });

  let cachedBaseUrl = null;
  let cachedSource = null;
  const getSource = () => {
    const nextUrl = getBaseUrl();
    if (!cachedSource || cachedBaseUrl !== nextUrl) {
      cachedBaseUrl = nextUrl;
      cachedSource = createEagleAssetSource(host, nextUrl);
    }
    return cachedSource;
  };

  const disposeAssetSource = host.contribute("assets.source", {
    id: EAGLE_PLUGIN_ID,
    name: "Eagle 素材库",
    description: "把 Eagle 作为站点的外部素材来源，直接浏览原始文件夹并读写 Eagle 文件。",
    provider: {
      listFolders: (signal) => getSource().listFolders(signal),
      list: (query) => getSource().list(query),
      importAsset: (item, signal) => getSource().importAsset(item, signal),
      uploadAsset: (asset, signal) => getSource().uploadAsset(asset, signal),
      uploadAssetToFolder: (asset, folderId, signal) =>
        getSource().uploadAssetToFolder(asset, folderId, signal),
      uploadFile: (file, folderId, signal) =>
        getSource().uploadFile(file, folderId, signal),
      createFolder: (name, parentId) => getSource().createFolder(name, parentId),
    },
  });

  return () => {
    disposePage?.();
    disposeSidebar?.();
    disposeSettings?.();
    disposeAssetSource?.();
  };
}

export default activate;
