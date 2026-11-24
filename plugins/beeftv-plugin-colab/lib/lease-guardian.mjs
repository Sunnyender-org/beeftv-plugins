// 独立租约守护子进程：监听插件宿主 stdin 管道关闭事件；
// 当宿主退出（含 process.exit(0) 或 SIGKILL）且无新进程接管租约时，自动向 Colab 发送释放显卡指令。

import { join } from "node:path";
import { ColabAuthStore, readJsonIfExists, withLeaseProcessLock, writePrivateJson } from "./colab-auth.mjs";
import { ColabControlClient, normalizeColabOrigin } from "./colab-client.mjs";
import { DEFAULT_COLAB_ORIGIN } from "./constants.mjs";

class LeaseTakenOverError extends Error {
  constructor() {
    super("lease taken over by another host");
    this.code = "LEASE_TAKEN_OVER";
  }
}

async function runGuardian() {
  const [stateDir, ownerPidStr, graceMsStr, allowLoopbackStr, colabCliTokenPath, expectedLeaseToken = ""] = process.argv.slice(2);
  if (!stateDir || !ownerPidStr) return;
  const ownerPid = Number(ownerPidStr);
  const graceMs = Math.max(20, Number(graceMsStr || 1200));
  const allowLoopbackOrigin = allowLoopbackStr === "1";

  let disarmed = false;
  await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("disarm")) {
        disarmed = true;
        resolve();
      }
    });
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
    process.stdin.on("error", resolve);
    process.stdin.resume?.();
  });

  if (disarmed) return;

  await new Promise((r) => setTimeout(r, graceMs));

  const settingsFile = join(stateDir, "settings.json");
  const isOwnedByThisGuardian = (record, expectedEndpoint = "") => {
    if (!record?.managedEndpoint) return false;
    if (expectedEndpoint && record.managedEndpoint !== expectedEndpoint) return false;
    if (record.leaseOwnerPid && Number(record.leaseOwnerPid) !== ownerPid) return false;
    if (expectedLeaseToken && record.leaseToken !== expectedLeaseToken) return false;
    return true;
  };

  const initialSettings = readJsonIfExists(settingsFile);
  if (!isOwnedByThisGuardian(initialSettings)) {
    // 租约已释放或已被新的插件宿主进程接管，不做释放。
    return;
  }

  const targetEndpoint = initialSettings.managedEndpoint;
  const targetAccountId = String(initialSettings.leaseAccountId || "");
  const authStore = new ColabAuthStore({
    stateDir,
    colabCliTokenPath: colabCliTokenPath || undefined,
  });

  // 仅在内存刷新租约所属账号的访问令牌（persist: false），绝不写回 auth.json，避免覆盖新宿主切换后的账号授权。
  let cachedToken = "";
  try {
    cachedToken = await authStore.resolveAccessToken({
      accountId: targetAccountId,
      signal: AbortSignal.timeout(8000),
      persist: false,
    });
  } catch {
    return;
  }
  if (!cachedToken || !isOwnedByThisGuardian(readJsonIfExists(settingsFile), targetEndpoint)) {
    return;
  }

  // 在跨进程租约锁内复核所有权、完成整个 unassign 请求并清理 settings.json，与新宿主启动接管互斥。
  try {
    await withLeaseProcessLock(
      stateDir,
      { role: "guardian", ownerPid, endpoint: targetEndpoint },
      async () => {
        const lockedSettings = readJsonIfExists(settingsFile);
        if (!isOwnedByThisGuardian(lockedSettings, targetEndpoint)) {
          return;
        }
        let safeOrigin = DEFAULT_COLAB_ORIGIN;
        try {
          safeOrigin = normalizeColabOrigin(lockedSettings.origin || DEFAULT_COLAB_ORIGIN, { allowLoopbackOrigin });
        } catch {
          safeOrigin = DEFAULT_COLAB_ORIGIN;
        }
        const control = new ColabControlClient({
          origin: safeOrigin,
          allowLoopbackOrigin,
          requestTimeoutMs: 8000,
          getAccessToken: async () => {
            if (!isOwnedByThisGuardian(readJsonIfExists(settingsFile), targetEndpoint)) {
              throw new LeaseTakenOverError();
            }
            return cachedToken;
          },
        });
        await control.unassignRuntime(targetEndpoint);
        const fresh = readJsonIfExists(settingsFile);
        if (isOwnedByThisGuardian(fresh, targetEndpoint)) {
          writePrivateJson(settingsFile, {
            ...fresh,
            managedEndpoint: "",
            leaseAccountId: "",
            idleDeadlineMs: 0,
            leaseOwnerPid: 0,
            leaseToken: "",
          });
        }
      },
      { timeoutMs: 20000 },
    );
  } catch {
    // 被新宿主接管、锁超时或网络断开导致释放失败时，不清空 settings.json。
  }
}

runGuardian()
  .catch(() => {})
  .finally(() => {
    process.exit(0);
  });
