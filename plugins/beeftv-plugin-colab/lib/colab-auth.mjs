// Google Colab OAuth2 授权管理：网页授权码交换、刷新令牌自动续期、0600 原子存储与本机 colab-cli 登录态复用。

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOGLE_OAUTH_CLIENT, PLUGIN_ID, buildGoogleAuthorizationUrl } from "./constants.mjs";
import { defaultFetch } from "./net-transport.mjs";

export { buildGoogleAuthorizationUrl };

const EXPIRY_SAFETY_MS = 120 * 1000;
const MODULE_FILE_PATH = fileURLToPath(import.meta.url);

export function resolveInstalledDataStateDir(moduleFilePath = MODULE_FILE_PATH, { platform = process.platform } = {}) {
  const pathOps = platform === "win32" ? win32 : { basename, dirname, join };
  let current = pathOps.dirname(String(moduleFilePath || ""));
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = pathOps.dirname(current);
    if (!parent || parent === current) break;
    if (pathOps.basename(current) === PLUGIN_ID && pathOps.basename(parent) === "plugins") {
      const dataDir = pathOps.dirname(parent);
      if (dataDir && dataDir !== parent) {
        return pathOps.join(dataDir, "plugin-state", PLUGIN_ID);
      }
    }
    current = parent;
  }
  return "";
}

export function resolvePluginStateDir(
  explicitDir,
  {
    moduleFilePath = MODULE_FILE_PATH,
    platform = process.platform,
    homeDir = homedir(),
    env = process.env,
  } = {},
) {
  if (explicitDir) return explicitDir;
  if (env?.BEEFTV_COLAB_STATE_DIR) return env.BEEFTV_COLAB_STATE_DIR;
  const installedDataState = resolveInstalledDataStateDir(moduleFilePath, { platform });
  if (installedDataState) return installedDataState;
  if (platform === "win32") {
    const roaming = env?.APPDATA || win32.join(homeDir, "AppData", "Roaming");
    return win32.join(roaming, PLUGIN_ID);
  }
  return join(homeDir, ".config", PLUGIN_ID);
}

export function resolveColabCliTokenPath() {
  if (process.env.BEEFTV_COLAB_CLI_TOKEN_PATH) return process.env.BEEFTV_COLAB_CLI_TOKEN_PATH;
  return join(homedir(), ".config", "colab-cli", "token.json");
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows 文件系统忽略 POSIX 权限位。
  }
}

export function writePrivateJson(filePath, value) {
  const dir = dirname(filePath);
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Windows 下忽略。
  }
  renameSync(tmpPath, filePath);
}

export function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const LEASE_LOCK_STALE_MS = 60 * 1000;

function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function isLeaseLockEntryStale(entryPath) {
  try {
    const stat = statSync(entryPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (!stat.isFile()) {
      return ageMs >= LEASE_LOCK_STALE_MS;
    }
    const raw = readFileSync(entryPath, "utf8").trim();
    if (!raw) {
      return ageMs >= LEASE_LOCK_STALE_MS;
    }
    const parsed = JSON.parse(raw);
    const createdAgeMs = parsed?.createdAtMs ? Date.now() - Number(parsed.createdAtMs) : ageMs;
    return createdAgeMs >= LEASE_LOCK_STALE_MS || (Boolean(parsed?.pid) && !isProcessAlive(parsed.pid));
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    try {
      const stat = statSync(entryPath);
      return Date.now() - stat.mtimeMs >= LEASE_LOCK_STALE_MS;
    } catch (statErr) {
      return statErr?.code === "ENOENT";
    }
  }
}

function tryClearStaleLeaseLock(lockPath) {
  let entries;
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    return false;
  }
  if (entries.length === 0) {
    // 活锁总是先在临时目录写好 owner-<nonce>.json 再原子 rename，空目录可安全用非递归 rmdir 回收。
    try {
      rmdirSync(lockPath);
      return true;
    } catch (err) {
      return err?.code === "ENOENT";
    }
  }
  for (const entry of entries) {
    if (!isLeaseLockEntryStale(join(lockPath, entry))) {
      return false;
    }
  }
  // 仅删除本次检查确认过期的特定 owner 文件名，绝不误删并发新接管者的 owner-<newNonce>.json；
  // 随后的非递归 rmdir 在目录已被新接管者填入时会自动返回 ENOTEMPTY，从根本上杜绝 TOCTOU。
  for (const entry of entries) {
    try {
      rmSync(join(lockPath, entry), { force: true });
    } catch {
      // ignore race
    }
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}

const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_SAB, 0, 0, Math.max(1, Math.floor(ms)));
}

function createLockStaging(stateDir, meta) {
  const nonce = randomBytes(12).toString("hex");
  const ownerFilename = `owner-${nonce}.json`;
  const tmpDir = join(stateDir, `.lock-tmp-${nonce}`);
  const tmpOwnerPath = join(tmpDir, ownerFilename);
  mkdirSync(tmpDir, { mode: 0o700 });
  try {
    chmodSync(tmpDir, 0o700);
  } catch {
    // Windows 下忽略。
  }
  const writeOwnerStamp = () => {
    const now = Date.now();
    writeFileSync(
      tmpOwnerPath,
      JSON.stringify({
        pid: process.pid,
        nonce,
        createdAtMs: now,
        ...(meta || {}),
      }),
      { mode: 0o600 },
    );
    return now;
  };
  return { ownerFilename, tmpDir, writeOwnerStamp };
}

function releaseDirectoryLock(lockPath, ownerFilename) {
  try {
    rmSync(join(lockPath, ownerFilename), { force: true });
  } catch {
    // ignore unlock race
  }
  try {
    rmdirSync(lockPath);
  } catch {
    // 若已有后进进程接管（ENOTEMPTY）或已被清理（ENOENT），安全忽略。
  }
}

function isLockContentionError(err, lockPath) {
  return (
    err?.code === "EEXIST" ||
    err?.code === "ENOTEMPTY" ||
    ((err?.code === "EPERM" || err?.code === "EACCES") && existsSync(lockPath))
  );
}

// 同步跨进程目录锁：用于 auth.json 短临界区（<1ms），保证读取比较与原子写入跨进程互斥。
function withDirectoryLockSync(stateDir, lockName, meta, fn, { timeoutMs = 10000, pollMs = 5 } = {}) {
  ensurePrivateDir(stateDir);
  const lockPath = join(stateDir, lockName);
  const { ownerFilename, tmpDir, writeOwnerStamp } = createLockStaging(stateDir, meta);
  let writtenAt = 0;
  let acquired = false;
  const deadline = Date.now() + Math.max(100, Number(timeoutMs || 10000));

  try {
    writtenAt = writeOwnerStamp();
    while (!acquired) {
      if (Date.now() - writtenAt >= 1000) {
        writtenAt = writeOwnerStamp();
      }
      try {
        renameSync(tmpDir, lockPath);
        acquired = true;
      } catch (err) {
        if (!isLockContentionError(err, lockPath)) {
          throw err;
        }
        if (tryClearStaleLeaseLock(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          const timeoutErr = new Error("等待跨进程状态锁超时");
          timeoutErr.code = "STATE_LOCK_TIMEOUT";
          throw timeoutErr;
        }
        sleepSync(pollMs);
      }
    }
  } finally {
    if (!acquired) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup error
      }
    }
  }

  try {
    return fn();
  } finally {
    releaseDirectoryLock(lockPath, ownerFilename);
  }
}

// 跨进程原子租约目录锁：先在私有临时目录写入唯一 owner-<nonce>.json，再原子 rename 到 lease.lock.d。
// 目标目录非空时 POSIX 返回 ENOTEMPTY/EEXIST、Windows 返回 EEXIST/EPERM/EACCES，保证多进程严格互斥。
export async function withLeaseProcessLock(
  stateDir,
  meta,
  fn,
  { timeoutMs = 15000, pollMs = 25, lockName = "lease.lock.d" } = {},
) {
  ensurePrivateDir(stateDir);
  const lockPath = join(stateDir, lockName);
  const { ownerFilename, tmpDir, writeOwnerStamp } = createLockStaging(stateDir, meta);
  let writtenAt = 0;
  let acquired = false;
  const deadline = Date.now() + Math.max(100, Number(timeoutMs || 15000));

  try {
    writtenAt = writeOwnerStamp();
    while (!acquired) {
      if (Date.now() - writtenAt >= 1000) {
        writtenAt = writeOwnerStamp();
      }
      try {
        renameSync(tmpDir, lockPath);
        acquired = true;
      } catch (err) {
        if (!isLockContentionError(err, lockPath)) {
          throw err;
        }
        if (tryClearStaleLeaseLock(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          const timeoutErr = new Error("等待跨进程租约锁超时");
          timeoutErr.code = "LEASE_LOCK_TIMEOUT";
          throw timeoutErr;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  } finally {
    if (!acquired) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup error
      }
    }
  }

  try {
    return await fn();
  } finally {
    releaseDirectoryLock(lockPath, ownerFilename);
  }
}

function sha256Hex(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

export function extractAuthCodeFromInput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const fromQuery = parsed.searchParams.get("code");
      if (fromQuery) return fromQuery.trim();
    } catch {
      // 不是合法 URL 时按原始文本处理。
    }
  }
  return trimmed;
}

function looksLikeAuthorizationCode(value) {
  return /^4\/[A-Za-z0-9_-]{16,}$/.test(value);
}

function looksLikeRefreshToken(value) {
  return /^1\/\/[A-Za-z0-9_-]{16,}$/.test(value);
}

function looksLikeAccessToken(value) {
  return /^ya29\.[A-Za-z0-9._-]{16,}$/.test(value);
}

async function postTokenEndpoint(
  formParams,
  { tokenUri = GOOGLE_OAUTH_CLIENT.tokenUri, fetchImpl = defaultFetch, signal } = {},
) {
  let response;
  try {
    response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(formParams).toString(),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("连不上 Google 账号授权服务，请检查本机网络或代理设置");
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const desc = String(body?.error_description || body?.error || "").toLowerCase();
    if (desc.includes("invalid_grant") || desc.includes("bad request") || desc.includes("expired")) {
      const err = new Error("Google 授权码已失效或用过一次了，请重新点「获取 Google 授权码」拿一个新的再试");
      err.code = "AUTH_INVALID_GRANT";
      throw err;
    }
    const err = new Error("Google 授权校验未通过，请重新获取授权码后再试");
    err.code = "AUTH_FAILED";
    throw err;
  }
  return body;
}

async function fetchAccountEmail(
  accessToken,
  { userInfoUri = GOOGLE_OAUTH_CLIENT.userInfoUri, fetchImpl = defaultFetch, signal } = {},
) {
  try {
    const res = await fetchImpl(userInfoUri, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal,
    });
    if (!res.ok) return "";
    const info = await res.json();
    return typeof info?.email === "string" ? info.email : "";
  } catch {
    return "";
  }
}

function readAuthDiskRaw(authFile) {
  const own = readJsonIfExists(authFile);
  if (!own || typeof own !== "object") return null;
  if (own.loggedOut) return own;
  return own.refreshToken || own.accessToken ? own : null;
}

export function getAccountFingerprint(record) {
  if (!record || record.loggedOut) return "";
  if (record.email) return `email:${String(record.email).trim().toLowerCase()}`;
  if (record.refreshToken) return `rt:${sha256Hex(record.refreshToken).slice(0, 24)}`;
  if (record.accessToken) return `at:${sha256Hex(record.accessToken).slice(0, 24)}`;
  return "";
}

export function recordMatchesAccountId(record, accountId) {
  const target = String(accountId || "").trim();
  if (!record || record.loggedOut || !target) return false;
  if (getAccountFingerprint(record) === target) return true;
  if (record.email && target === `email:${String(record.email).trim().toLowerCase()}`) return true;
  if (record.refreshToken && target === `rt:${sha256Hex(record.refreshToken).slice(0, 24)}`) return true;
  if (record.accessToken && target === `at:${sha256Hex(record.accessToken).slice(0, 24)}`) return true;
  return false;
}

function snapshotPreviousAccount(record) {
  return {
    accessToken: String(record.accessToken || ""),
    refreshToken: String(record.refreshToken || ""),
    clientId: String(record.clientId || ""),
    clientSecret: String(record.clientSecret || ""),
    tokenUri: String(record.tokenUri || ""),
    expiresAtMs: Number(record.expiresAtMs || 0),
    email: String(record.email || ""),
    source: String(record.source || "plugin"),
    updatedAt: String(record.updatedAt || new Date().toISOString()),
  };
}

function buildPreviousAccountsMap(prevRaw, nextRecord) {
  const prev = prevRaw && !prevRaw.loggedOut && (prevRaw.refreshToken || prevRaw.accessToken) ? prevRaw : null;
  const map = prev?.previousAccounts && typeof prev.previousAccounts === "object"
    ? { ...prev.previousAccounts }
    : {};
  const nextId = getAccountFingerprint(nextRecord);
  if (prev) {
    const prevId = getAccountFingerprint(prev);
    if (prevId && prevId !== nextId && !recordMatchesAccountId(prev, nextId)) {
      map[prevId] = snapshotPreviousAccount(prev);
    }
  }
  for (const key of Object.keys(map)) {
    if (key === nextId || recordMatchesAccountId(nextRecord, key)) {
      delete map[key];
    }
  }
  const trimmedEntries = Object.entries(map)
    .sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")))
    .slice(0, 2);
  return Object.fromEntries(trimmedEntries);
}

function isSameAuthDiskState(expectedRaw, currentRaw) {
  if (!expectedRaw && !currentRaw) return true;
  if (!expectedRaw || !currentRaw) return false;
  if (Boolean(expectedRaw.loggedOut) !== Boolean(currentRaw.loggedOut)) return false;
  if (expectedRaw.loggedOut) {
    return (expectedRaw.logoutEpoch || "") === (currentRaw.logoutEpoch || "");
  }
  if ((expectedRaw.refreshToken || "") !== (currentRaw.refreshToken || "")) return false;
  if ((expectedRaw.inputHash || "") !== (currentRaw.inputHash || "")) return false;
  if ((expectedRaw.email || "") !== (currentRaw.email || "")) return false;
  return true;
}

export class ColabAuthStore {
  constructor({ stateDir, colabCliTokenPath, oauth = GOOGLE_OAUTH_CLIENT, fetchImpl = defaultFetch } = {}) {
    this.stateDir = resolvePluginStateDir(stateDir);
    this.authFile = join(this.stateDir, "auth.json");
    this.colabCliTokenPath = colabCliTokenPath ?? resolveColabCliTokenPath();
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
  }

  #withAuthLock(fn) {
    return withDirectoryLockSync(this.stateDir, "auth.lock.d", { role: "auth-store" }, fn);
  }

  #readColabCliRecord(fullDisk = null) {
    const cli = readJsonIfExists(this.colabCliTokenPath);
    if (!cli || !(cli.refresh_token || cli.token)) return null;
    const expiryMs = cli.expiry ? Date.parse(cli.expiry) : 0;
    const base = {
      accessToken: cli.token || "",
      refreshToken: cli.refresh_token || "",
      clientId: cli.client_id || this.oauth.clientId,
      clientSecret: cli.client_secret || this.oauth.clientSecret,
      tokenUri: cli.token_uri || this.oauth.tokenUri,
      expiresAtMs: Number.isFinite(expiryMs) ? expiryMs : 0,
      email: cli.email || "",
      source: "colab-cli",
    };
    const cache = fullDisk && !fullDisk.loggedOut ? fullDisk.cliRefreshCache : null;
    if (
      cache &&
      base.refreshToken &&
      cache.refreshToken === base.refreshToken &&
      cache.accessToken &&
      Number(cache.expiresAtMs || 0) > base.expiresAtMs
    ) {
      return {
        ...base,
        accessToken: String(cache.accessToken),
        expiresAtMs: Number(cache.expiresAtMs),
        email: base.email || String(cache.email || ""),
        updatedAt: String(cache.updatedAt || ""),
      };
    }
    return base;
  }

  #readStoredState() {
    const fullDisk = readJsonIfExists(this.authFile);
    const raw = readAuthDiskRaw(this.authFile);
    if (raw?.loggedOut) {
      return { stored: null, diskSnapshot: raw, rawAuth: raw };
    }
    if (raw && raw.source !== "colab-cli") {
      return { stored: { ...raw, source: raw.source || "plugin" }, diskSnapshot: raw, rawAuth: raw };
    }
    const cliRecord = this.#readColabCliRecord(fullDisk);
    if (cliRecord) {
      return { stored: cliRecord, diskSnapshot: null, rawAuth: null };
    }
    return { stored: null, diskSnapshot: null, rawAuth: null };
  }

  readStored() {
    return this.#readStoredState().stored;
  }

  getPublicStatus() {
    const stored = this.readStored();
    if (!stored) return { authorized: false, email: "", source: "" };
    return {
      authorized: true,
      email: stored.email || "",
      source: stored.source || "plugin",
      updatedAt: stored.updatedAt || "",
    };
  }

  isCurrentAccount(accountId, apiKey = "") {
    const target = String(accountId || "").trim();
    if (!target) return true;
    const trimmedKey = extractAuthCodeFromInput(apiKey);
    if (trimmedKey && looksLikeAccessToken(trimmedKey)) {
      return target === `at:${sha256Hex(trimmedKey).slice(0, 24)}`;
    }
    const stored = this.readStored();
    if (stored) {
      return recordMatchesAccountId(stored, target);
    }
    if (trimmedKey && trimmedKey !== "local" && trimmedKey !== "colab") {
      return target === `at:${sha256Hex(trimmedKey).slice(0, 24)}`;
    }
    return false;
  }

  getCurrentAccountId(apiKey = "") {
    const trimmedKey = extractAuthCodeFromInput(apiKey);
    if (trimmedKey && looksLikeAccessToken(trimmedKey)) {
      return `at:${sha256Hex(trimmedKey).slice(0, 24)}`;
    }
    const stored = this.readStored();
    if (stored) {
      return getAccountFingerprint(stored);
    }
    if (trimmedKey && trimmedKey !== "local" && trimmedKey !== "colab") {
      return `at:${sha256Hex(trimmedKey).slice(0, 24)}`;
    }
    return "";
  }

  willSwitchAccount(apiKey = "") {
    const trimmedKey = extractAuthCodeFromInput(apiKey);
    if (!trimmedKey || trimmedKey === "local" || trimmedKey === "colab") return false;
    const stored = this.readStored();
    if (!stored) return false;
    if (looksLikeAccessToken(trimmedKey)) {
      return Boolean(stored.accessToken && stored.accessToken !== trimmedKey);
    }
    if (looksLikeRefreshToken(trimmedKey)) {
      return stored.refreshToken !== trimmedKey;
    }
    if (looksLikeAuthorizationCode(trimmedKey)) {
      const keyHash = sha256Hex(trimmedKey);
      const alreadyConsumed = Boolean(
        stored.inputHash === keyHash ||
          (Array.isArray(stored.knownCodeHashes) && stored.knownCodeHashes.includes(keyHash)),
      );
      return !alreadyConsumed;
    }
    return false;
  }

  clearStored() {
    this.#withAuthLock(() => {
      // 显式写入退出标记（清空凭证并禁用 colab-cli 自动复用），
      // 让并发在途续期（含 CLI 凭证续期）在锁内比对失败，避免退出后凭证被写回或自动回退复用。
      writePrivateJson(this.authFile, {
        loggedOut: true,
        disableCliFallback: true,
        logoutEpoch: randomUUID(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  pruneInactiveAccounts() {
    this.#withAuthLock(() => {
      const full = readJsonIfExists(this.authFile);
      if (!full || typeof full !== "object" || full.loggedOut) return;
      const hasPrev = Boolean(full.previousAccounts && Object.keys(full.previousAccounts).length > 0);
      const hasLeaseCreds = Boolean(full.leaseCredentials && Object.keys(full.leaseCredentials).length > 0);
      const cliCurrent = this.#readColabCliRecord(null);
      const staleCliCache = Boolean(
        full.cliRefreshCache &&
          (!cliCurrent?.refreshToken || full.cliRefreshCache.refreshToken !== cliCurrent.refreshToken),
      );
      if (!hasPrev && !hasLeaseCreds && !staleCliCache) return;
      const cleaned = { ...full };
      delete cleaned.previousAccounts;
      delete cleaned.leaseCredentials;
      if (staleCliCache) {
        delete cleaned.cliRefreshCache;
      }
      if (cleaned.refreshToken || cleaned.accessToken || cleaned.cliRefreshCache) {
        writePrivateJson(this.authFile, cleaned);
      } else {
        rmSync(this.authFile, { force: true });
      }
    });
  }

  retainAccountForLease(accountId, apiKey = "") {
    const target = String(accountId || "").trim();
    if (!target) return;
    this.#withAuthLock(() => {
      const full = readJsonIfExists(this.authFile);
      if (full?.loggedOut) return;

      let sourceRecord = null;
      if (full && (full.refreshToken || full.accessToken) && recordMatchesAccountId(full, target)) {
        sourceRecord = full;
      }
      if (!sourceRecord) {
        const cliRecord = this.#readColabCliRecord(full);
        if (cliRecord && recordMatchesAccountId(cliRecord, target)) {
          sourceRecord = cliRecord;
        }
      }
      if (!sourceRecord) {
        const trimmedKey = extractAuthCodeFromInput(apiKey);
        if (trimmedKey && looksLikeAccessToken(trimmedKey) && target === `at:${sha256Hex(trimmedKey).slice(0, 24)}`) {
          sourceRecord = {
            accessToken: trimmedKey,
            refreshToken: "",
            expiresAtMs: Date.now() + 3600 * 1000,
            email: "",
            source: "session-key",
            updatedAt: new Date().toISOString(),
          };
        }
      }
      if (!sourceRecord) return;

      const existingLeaseCreds = full?.leaseCredentials && typeof full.leaseCredentials === "object"
        ? { ...full.leaseCredentials }
        : {};
      existingLeaseCreds[target] = snapshotPreviousAccount(sourceRecord);
      const trimmedLeaseCreds = Object.fromEntries(
        Object.entries(existingLeaseCreds)
          .sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")))
          .slice(0, 2),
      );
      const nextDoc = full && typeof full === "object"
        ? { ...full, leaseCredentials: trimmedLeaseCreds }
        : { leaseCredentials: trimmedLeaseCreds, updatedAt: new Date().toISOString() };
      writePrivateJson(this.authFile, nextDoc);
    });
  }

  #commitExplicitRecord(baseRecord, { addCodeHash = "" } = {}) {
    return this.#withAuthLock(() => {
      const fullDisk = readJsonIfExists(this.authFile);
      const prevRaw = readAuthDiskRaw(this.authFile);
      const prev = prevRaw && !prevRaw.loggedOut ? prevRaw : null;
      const prevHashes = Array.isArray(prev?.knownCodeHashes) ? prev.knownCodeHashes : [];
      const extraPrevHash = prev?.inputHash ? [prev.inputHash] : [];
      const knownCodeHashes = [
        ...new Set([...prevHashes, ...extraPrevHash, ...(addCodeHash ? [addCodeHash] : [])]),
      ].slice(-16);
      const previousAccounts = buildPreviousAccountsMap(prevRaw, baseRecord);
      const leaseCredentials = !fullDisk?.loggedOut && fullDisk?.leaseCredentials && typeof fullDisk.leaseCredentials === "object"
        ? fullDisk.leaseCredentials
        : null;
      const record = {
        ...baseRecord,
        knownCodeHashes,
        ...(Object.keys(previousAccounts).length > 0 ? { previousAccounts } : {}),
        ...(leaseCredentials && Object.keys(leaseCredentials).length > 0 ? { leaseCredentials } : {}),
      };
      writePrivateJson(this.authFile, record);
      return record;
    });
  }

  async authorizeWithCode(rawInput, { signal } = {}) {
    const input = extractAuthCodeFromInput(rawInput);
    if (!input) {
      throw new Error("请先粘贴从 Google 授权页面拿到的授权码");
    }
    const inputHash = sha256Hex(input);

    if (looksLikeRefreshToken(input)) {
      return this.#saveAndRefresh(
        {
          refreshToken: input,
          inputHash,
          source: "plugin",
        },
        { signal, explicitCommit: true },
      );
    }
    const tokenResp = await postTokenEndpoint(
      {
        code: input,
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        redirect_uri: this.oauth.redirectUri,
        grant_type: "authorization_code",
      },
      { tokenUri: this.oauth.tokenUri, fetchImpl: this.fetchImpl, signal },
    );
    const accessToken = String(tokenResp?.access_token || "");
    const refreshToken = String(tokenResp?.refresh_token || "");
    if (!accessToken) {
      throw new Error("Google 授权未返回有效访问凭证，请重试");
    }
    const expiresInSec = Number(tokenResp?.expires_in || 3600);
    const email = await fetchAccountEmail(accessToken, {
      userInfoUri: this.oauth.userInfoUri,
      fetchImpl: this.fetchImpl,
      signal,
    });
    const baseRecord = {
      accessToken,
      refreshToken,
      clientId: this.oauth.clientId,
      clientSecret: this.oauth.clientSecret,
      tokenUri: this.oauth.tokenUri,
      expiresAtMs: Date.now() + expiresInSec * 1000,
      email,
      inputHash,
      source: "plugin",
      updatedAt: new Date().toISOString(),
    };
    return this.#commitExplicitRecord(baseRecord, { addCodeHash: inputHash });
  }

  async #saveAndRefresh(record, { signal, persist = true, expectedDisk, explicitCommit = false } = {}) {
    const tokenResp = await postTokenEndpoint(
      {
        refresh_token: record.refreshToken,
        client_id: record.clientId || this.oauth.clientId,
        client_secret: record.clientSecret || this.oauth.clientSecret,
        grant_type: "refresh_token",
      },
      { tokenUri: record.tokenUri || this.oauth.tokenUri, fetchImpl: this.fetchImpl, signal },
    );
    const accessToken = String(tokenResp?.access_token || "");
    if (!accessToken) {
      throw new Error("Google 登录状态已过期，请重新获取授权码登录");
    }
    const expiresInSec = Number(tokenResp?.expires_in || 3600);
    const email = record.email || (persist
      ? await fetchAccountEmail(accessToken, {
          userInfoUri: this.oauth.userInfoUri,
          fetchImpl: this.fetchImpl,
          signal,
        })
      : "");
    const next = {
      ...record,
      accessToken,
      refreshToken: String(tokenResp?.refresh_token || record.refreshToken || ""),
      clientId: record.clientId || this.oauth.clientId,
      clientSecret: record.clientSecret || this.oauth.clientSecret,
      tokenUri: record.tokenUri || this.oauth.tokenUri,
      expiresAtMs: Date.now() + expiresInSec * 1000,
      email,
      updatedAt: new Date().toISOString(),
    };
    if (persist) {
      if (explicitCommit) {
        return this.#commitExplicitRecord(next);
      }
      // 读取比对与原子写入放在同一跨进程 auth.lock.d 临界区，杜绝多进程交错覆盖切号或退出状态。
      // CLI 凭证自动续期只写入 cliRefreshCache，不占顶层插件登录槽，确保外部 colab-cli 切号后立即跟随新账号。
      this.#withAuthLock(() => {
        const fullDisk = readJsonIfExists(this.authFile);
        const currentRaw = readAuthDiskRaw(this.authFile);
        if (isSameAuthDiskState(expectedDisk, currentRaw)) {
          if (record.source === "colab-cli") {
            const nextDoc = {
              ...(fullDisk && typeof fullDisk === "object" ? fullDisk : {}),
              cliRefreshCache: snapshotPreviousAccount(next),
              updatedAt: next.updatedAt,
            };
            writePrivateJson(this.authFile, nextDoc);
          } else {
            const toSave = {
              ...next,
              ...(currentRaw?.previousAccounts ? { previousAccounts: currentRaw.previousAccounts } : {}),
              ...(!fullDisk?.loggedOut && fullDisk?.leaseCredentials ? { leaseCredentials: fullDisk.leaseCredentials } : {}),
            };
            writePrivateJson(this.authFile, toSave);
          }
        }
      });
    }
    return next;
  }

  async resolveAccessToken({ apiKey = "", accountId = "", signal, persist = true } = {}) {
    const { stored, diskSnapshot, rawAuth } = this.#readStoredState();
    const targetAccountId = String(accountId || "").trim();

    if (targetAccountId) {
      if (stored && recordMatchesAccountId(stored, targetAccountId)) {
        if (stored.accessToken && stored.expiresAtMs - Date.now() > EXPIRY_SAFETY_MS) {
          return stored.accessToken;
        }
        if (stored.refreshToken) {
          const refreshed = await this.#saveAndRefresh(stored, {
            signal,
            persist,
            expectedDisk: diskSnapshot,
          });
          return refreshed.accessToken;
        }
        if (stored.accessToken) return stored.accessToken;
      }

      const fullDisk = readJsonIfExists(this.authFile);
      const fallbackEntries = [];
      if (!fullDisk?.loggedOut && fullDisk?.leaseCredentials && typeof fullDisk.leaseCredentials === "object") {
        fallbackEntries.push(...Object.entries(fullDisk.leaseCredentials));
      }
      if (!rawAuth?.loggedOut && rawAuth?.previousAccounts && typeof rawAuth.previousAccounts === "object") {
        fallbackEntries.push(...Object.entries(rawAuth.previousAccounts));
      }
      for (const [prevKey, prevRec] of fallbackEntries) {
        if (prevKey === targetAccountId || recordMatchesAccountId(prevRec, targetAccountId)) {
          if (prevRec.accessToken && prevRec.expiresAtMs - Date.now() > EXPIRY_SAFETY_MS) {
            return prevRec.accessToken;
          }
          if (prevRec.refreshToken) {
            const refreshed = await this.#saveAndRefresh(prevRec, { signal, persist: false });
            return refreshed.accessToken;
          }
          if (prevRec.accessToken) return prevRec.accessToken;
        }
      }

      if (!rawAuth?.loggedOut) {
        const cliRecord = this.#readColabCliRecord(fullDisk);
        if (cliRecord && recordMatchesAccountId(cliRecord, targetAccountId)) {
          if (cliRecord.accessToken && cliRecord.expiresAtMs - Date.now() > EXPIRY_SAFETY_MS) {
            return cliRecord.accessToken;
          }
          if (cliRecord.refreshToken) {
            const refreshed = await this.#saveAndRefresh(cliRecord, { signal, persist: false });
            return refreshed.accessToken;
          }
          if (cliRecord.accessToken) return cliRecord.accessToken;
        }
      }

      const err = new Error("找不到该云端显卡所属账号的授权凭证，请切回原账号或前往 Colab 网页释放");
      err.code = "AUTH_MISSING";
      throw err;
    }

    const trimmedKey = extractAuthCodeFromInput(apiKey);

    if (trimmedKey && trimmedKey !== "local" && trimmedKey !== "colab") {
      if (looksLikeAccessToken(trimmedKey)) {
        return trimmedKey;
      }
      if (looksLikeRefreshToken(trimmedKey)) {
        // Refresh token 可重复使用：仅当它与当前生效凭证相同时跳过换票，允许从账号 B 切回曾经用过的账号 A。
        if (!stored || stored.refreshToken !== trimmedKey) {
          const exchanged = await this.authorizeWithCode(trimmedKey, { signal });
          return exchanged.accessToken;
        }
      } else if (looksLikeAuthorizationCode(trimmedKey)) {
        const keyHash = sha256Hex(trimmedKey);
        const alreadyConsumed = Boolean(
          stored &&
            (stored.inputHash === keyHash ||
              (Array.isArray(stored.knownCodeHashes) && stored.knownCodeHashes.includes(keyHash))),
        );
        if (!alreadyConsumed) {
          const exchanged = await this.authorizeWithCode(trimmedKey, { signal });
          return exchanged.accessToken;
        }
      } else if (!stored) {
        // 在本地调试/模拟测试环境允许直接把测试密钥作为 Bearer 凭证使用。
        return trimmedKey;
      }
    }

    if (!stored) {
      const err = new Error("还没有登录 Google Colab 账号。请在插件设置点「获取 Google 授权码」，把授权码填进 API Key 一栏后再试");
      err.code = "AUTH_MISSING";
      throw err;
    }

    if (stored.accessToken && stored.expiresAtMs - Date.now() > EXPIRY_SAFETY_MS) {
      return stored.accessToken;
    }

    if (stored.refreshToken) {
      const refreshed = await this.#saveAndRefresh(stored, {
        signal,
        persist,
        expectedDisk: diskSnapshot,
      });
      return refreshed.accessToken;
    }

    if (stored.accessToken) {
      return stored.accessToken;
    }

    const err = new Error("Google Colab 登录状态已过期，请重新获取授权码登录");
    err.code = "AUTH_EXPIRED";
    throw err;
  }
}
