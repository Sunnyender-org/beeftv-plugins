// Colab 会话、持久化租约回收、任务调度与闲置自动关机看门狗。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLAB_MODELS,
  CONTROL_SERVER_PORTS,
  DEFAULT_COLAB_ORIGIN,
  DEFAULT_IDLE_STOP_MINUTES,
  GPU_PREFERENCES,
  buildGoogleAuthorizationUrl,
  resolveAcceleratorCandidates,
} from "./constants.mjs";
import {
  ColabAuthStore,
  readJsonIfExists,
  resolvePluginStateDir,
  withLeaseProcessLock,
  writePrivateJson,
} from "./colab-auth.mjs";
import { ColabControlClient, ColabRuntimeProxyClient, normalizeColabOrigin } from "./colab-client.mjs";
import { ColabLocalControlServer } from "./local-control-server.mjs";
import { defaultFetch } from "./net-transport.mjs";
import { DefaultWebSocket } from "./ws-tunnel.mjs";
import {
  REMOTE_WORKER_ROOT,
  REMOTE_WORKER_SCRIPT,
  buildKernelLauncherCode,
  buildRemoteWorkerPythonSource,
} from "./remote-worker-py.mjs";
import { ColabTaskStore, readReferenceImages } from "./task-store.mjs";
import { compileGenerationPlan, validateGenerationRequest } from "./workflows.mjs";

const PROXY_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const WORKER_HEARTBEAT_STALE_SEC = 45;
const DEFAULT_HEARTBEAT_STALE_WINDOW_MS = 120 * 1000;
const DEFAULT_IMMEDIATE_STOP_RETRY_MS = 30 * 1000;
const CCU_CACHE_TTL_MS = 15 * 1000;
const GUARDIAN_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "lease-guardian.mjs");

export class ColabSessionManager {
  constructor({
    stateDir,
    colabCliTokenPath,
    fetchImpl = defaultFetch,
    webSocketImpl = DefaultWebSocket,
    controlPorts = CONTROL_SERVER_PORTS,
    pollIntervalMs = 1800,
    workerReadyTimeoutMs = 20000,
    heartbeatStaleWindowMs = DEFAULT_HEARTBEAT_STALE_WINDOW_MS,
    immediateStopRetryMs = DEFAULT_IMMEDIATE_STOP_RETRY_MS,
    allowLoopbackOrigin = false,
    installExitHooks = false,
    guardianGraceMs = 1200,
  } = {}) {
    this.stateDir = resolvePluginStateDir(stateDir);
    this.colabCliTokenPath = colabCliTokenPath || "";
    this.mediaDir = join(this.stateDir, "media");
    this.tasksDir = join(this.stateDir, "tasks");
    this.settingsFile = join(this.stateDir, "settings.json");
    this.fetchImpl = fetchImpl;
    this.webSocketImpl = webSocketImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.workerReadyTimeoutMs = workerReadyTimeoutMs;
    this.heartbeatStaleWindowMs = heartbeatStaleWindowMs;
    this.immediateStopRetryMs = Math.max(50, Number(immediateStopRetryMs || DEFAULT_IMMEDIATE_STOP_RETRY_MS));
    this.allowLoopbackOrigin = Boolean(allowLoopbackOrigin);
    this.enableLeaseGuardian = Boolean(installExitHooks);
    this.guardianGraceMs = guardianGraceMs;

    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });

    this.authStore = new ColabAuthStore({
      stateDir: this.stateDir,
      colabCliTokenPath,
      fetchImpl: this.fetchImpl,
    });
    this.taskStore = new ColabTaskStore({ tasksDir: this.tasksDir });

    this.settings = this.#loadSettings();
    this.queue = [];
    this.pumping = false;
    this.executingTask = false;
    this.leaseQueue = Promise.resolve();

    this.activeAssignment = null;
    this.workerVerifiedAtMs = 0;
    this.remoteState = null;
    this.ccuSnapshot = null;
    this.sessionsSnapshot = null;
    this.ccuFetchedAtMs = 0;
    this.idleTimer = null;
    this.idleDeadlineMs = 0;
    this.lastApiKey = "";
    this.guardianChild = null;
    this.guardianLeaseToken = "";
    this.leaseEpoch = 0;

    this.localServer = new ColabLocalControlServer({
      mediaDir: this.mediaDir,
      controlPorts,
      handlers: {
        onGetStatus: ({ forceRefresh }) => this.getDashboardStatus({ forceRefresh }),
        onUpdateSettings: async (patch) => {
          let stoppedIdle = false;
          await this.#runLeaseOp(async () => {
            this.#saveSettings(patch);
            const hasManagedRuntime = Boolean(this.activeAssignment || this.settings.managedEndpoint);
            if (
              this.settings.idleStopMinutes === 0 &&
              hasManagedRuntime &&
              !this.executingTask &&
              this.queue.length === 0
            ) {
              await this.#stopRuntimeLocked({ releaseAll: false, verifySessions: false, onlyIfIdle: true });
              stoppedIdle = true;
              return;
            }
            this.#armIdleTimerIfIdle();
          });
          return this.getDashboardStatus({ forceRefresh: stoppedIdle });
        },
        onStop: async ({ releaseAll }) => {
          await this.stopRuntime({ releaseAll, verifySessions: false });
          return this.getDashboardStatus({ forceRefresh: true });
        },
      },
    });

    this.#reconcileStartupState();
  }

  get serverPort() {
    return this.localServer.serverPort;
  }

  #runLeaseOp(fn) {
    const next = this.leaseQueue.then(fn, fn);
    this.leaseQueue = next.catch(() => {});
    return next;
  }

  #loadSettings() {
    const saved = readJsonIfExists(this.settingsFile) || {};
    const gpuPreference = GPU_PREFERENCES.includes(saved.gpuPreference) ? saved.gpuPreference : "auto";
    const idleNum = Number(saved.idleStopMinutes);
    const idleStopMinutes = Number.isFinite(idleNum) && idleNum >= 0 && idleNum <= 180
      ? idleNum
      : DEFAULT_IDLE_STOP_MINUTES;
    let origin = DEFAULT_COLAB_ORIGIN;
    try {
      origin = normalizeColabOrigin(saved.origin || DEFAULT_COLAB_ORIGIN, {
        allowLoopbackOrigin: this.allowLoopbackOrigin,
      });
    } catch {
      origin = DEFAULT_COLAB_ORIGIN;
    }
    const next = {
      notebookHash: saved.notebookHash || randomUUID(),
      gpuPreference,
      idleStopMinutes,
      managedEndpoint: String(saved.managedEndpoint || ""),
      leaseAccountId: String(saved.leaseAccountId || ""),
      idleDeadlineMs: Number(saved.idleDeadlineMs || 0),
      leaseOwnerPid: Number(saved.leaseOwnerPid || 0),
      leaseToken: String(saved.leaseToken || ""),
      origin,
    };
    if (!saved.notebookHash) {
      writePrivateJson(this.settingsFile, next);
    }
    return next;
  }

  #saveSettings(patch = {}) {
    this.settings = { ...this.settings, ...patch };
    writePrivateJson(this.settingsFile, this.settings);
    return this.settings;
  }

  #reconcileStartupState() {
    this.taskStore.reconcileStartupTasks();
    if (!this.settings.managedEndpoint) return;

    // 通过跨进程租约锁串行化启动接管与旧守护进程的在途停机请求，避免接管正在被旧进程释放的实例。
    void this.#runLeaseOp(async () => {
      try {
        await withLeaseProcessLock(
          this.stateDir,
          { role: "host-reconcile" },
          async () => {
            this.settings = this.#loadSettings();
            this.leaseEpoch += 1;
            if (!this.settings.managedEndpoint) {
              return;
            }
            if (this.settings.leaseAccountId) {
              this.authStore.retainAccountForLease(this.settings.leaseAccountId);
            }
            this.#saveSettings({ leaseOwnerPid: process.pid, leaseToken: randomUUID() });
            this.#ensureLeaseGuardian();
          },
          { timeoutMs: 20000 },
        );
      } catch {
        // 若旧守护进程超时未释放锁，说明旧实例正处于受争议/停机状态：不覆盖磁盘，但在本进程放弃沿用旧 endpoint。
        const latest = this.#loadSettings();
        this.leaseEpoch += 1;
        this.activeAssignment = null;
        if (!latest.managedEndpoint || Number(latest.leaseOwnerPid) !== process.pid) {
          this.settings = { ...latest, managedEndpoint: "", leaseAccountId: "", idleDeadlineMs: 0, leaseToken: "" };
        } else {
          this.settings = latest;
        }
        return;
      }

      if (!this.settings.managedEndpoint) return;
      const persistedDeadline = Number(this.settings.idleDeadlineMs || 0);
      if (this.settings.idleStopMinutes === 0 || (persistedDeadline > 0 && Date.now() >= persistedDeadline)) {
        await this.#stopRuntimeLocked({ releaseAll: false, verifySessions: true, onlyIfIdle: true });
      } else {
        this.#armIdleTimerIfIdle(persistedDeadline > Date.now() ? persistedDeadline : 0);
      }
    }).catch(() => {});
  }

  #ensureLeaseGuardian() {
    if (!this.enableLeaseGuardian || !this.settings.managedEndpoint) return;
    const token = String(this.settings.leaseToken || "");
    if (this.guardianChild && !this.guardianChild.killed && this.guardianLeaseToken === token) return;
    this.#disarmLeaseGuardian();
    try {
      const child = spawn(
        process.execPath,
        [
          GUARDIAN_SCRIPT_PATH,
          this.stateDir,
          String(process.pid),
          String(this.guardianGraceMs),
          this.allowLoopbackOrigin ? "1" : "0",
          this.colabCliTokenPath,
          token,
        ],
        {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        },
      );
      child.stdin?.on?.("error", () => {});
      child.stdin?.unref?.();
      child.unref();
      child.once("exit", () => {
        if (this.guardianChild === child) {
          this.guardianChild = null;
          this.guardianLeaseToken = "";
        }
      });
      this.guardianChild = child;
      this.guardianLeaseToken = token;
    } catch {
      // 极端受限环境下退化为下次启动时回收。
    }
  }

  #disarmLeaseGuardian() {
    const child = this.guardianChild;
    this.guardianChild = null;
    this.guardianLeaseToken = "";
    if (!child) return;
    try {
      child.stdin?.write?.("disarm\n");
      child.stdin?.end?.();
    } catch {
      // ignore closed pipe
    }
  }

  #rememberSessionApiKey(rawKey) {
    const trimmed = String(rawKey || "").trim();
    if (!trimmed || trimmed === "local" || trimmed === "colab") return;
    // 仅缓存临时会话 Bearer token（如 ya29... 或本地测试密钥），不缓存 4/... 授权码或 1//... 刷新令牌，
    // 避免后台面板轮询或停机调用重放旧刷新令牌把新切换的账号悄悄切回去。
    if (!/^(?:4\/|1\/\/)/.test(trimmed)) {
      this.lastApiKey = trimmed;
    } else {
      this.lastApiKey = "";
    }
  }

  #createControlClient(config = {}) {
    const targetAccountId = String(config.accountId || "").trim();
    const incomingKey = targetAccountId ? "" : String(config.apiKey || "").trim();
    if (incomingKey) {
      this.#rememberSessionApiKey(incomingKey);
    }
    const origin = normalizeColabOrigin(config.baseUrl || this.settings.origin, {
      allowLoopbackOrigin: this.allowLoopbackOrigin,
    });
    if (origin !== this.settings.origin) {
      this.#saveSettings({ origin });
    }
    return new ColabControlClient({
      origin,
      allowLoopbackOrigin: this.allowLoopbackOrigin,
      fetchImpl: this.fetchImpl,
      getAccessToken: ({ signal } = {}) =>
        targetAccountId
          ? this.authStore.resolveAccessToken({ accountId: targetAccountId, signal })
          : this.authStore.resolveAccessToken({
              apiKey: config.ignoreLastApiKey ? "" : (incomingKey || this.lastApiKey || ""),
              signal,
            }),
    });
  }

  async #releaseManagedBeforeAccountSwitch(incomingKey, { signal } = {}) {
    const trimmed = String(incomingKey || "").trim();
    const switchingByStored = this.authStore.willSwitchAccount(trimmed);
    const switchingByLeaseOwner = Boolean(
      trimmed &&
        this.settings.managedEndpoint &&
        this.settings.leaseAccountId &&
        !this.authStore.isCurrentAccount(this.settings.leaseAccountId, trimmed),
    );
    if (!switchingByStored && !switchingByLeaseOwner) return;
    await this.#runLeaseOp(async () => {
      if (!this.activeAssignment && !this.settings.managedEndpoint) return;
      if (this.executingTask || this.queue.length > 0) {
        throw new Error("当前仍有生图任务在旧账号的云端显卡上运行，请等待完成或先点击「立即停止显卡」后再切换账号");
      }
      try {
        await this.#stopRuntimeLocked({ releaseAll: false, verifySessions: false, onlyIfIdle: false, signal });
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "AUTH_INVALID_GRANT" || code === "AUTH_EXPIRED" || code === "AUTH_MISSING" || Number(error?.status) === 401) {
          return;
        }
        throw error;
      }
    });
  }

  async ensureLocalServer() {
    return this.localServer.ensureStarted();
  }

  async close() {
    this.#clearIdleTimer({ persist: false });
    this.#disarmLeaseGuardian();
    await this.localServer.close();
  }

  async getDashboardStatus({ forceRefresh = false } = {}) {
    const storedAuth = this.authStore.getPublicStatus();
    const auth = storedAuth.authorized
      ? storedAuth
      : this.lastApiKey
        ? { authorized: true, email: "", source: "session-key", updatedAt: "" }
        : storedAuth;
    if (auth.authorized && (forceRefresh || Date.now() - this.ccuFetchedAtMs > CCU_CACHE_TTL_MS)) {
      const snapshotEndpoint = this.settings.managedEndpoint;
      const snapshotLeaseAccountId = String(this.settings.leaseAccountId || "");
      const snapshotEpoch = this.leaseEpoch;
      const sameLeaseAccount = this.authStore.isCurrentAccount(snapshotLeaseAccountId, this.lastApiKey || "");
      try {
        const client = this.#createControlClient();
        const [ccu, assignments] = await Promise.all([
          client.getConsumptionInfo(),
          client.listAssignments(),
        ]);
        this.ccuSnapshot = ccu;
        this.ccuFetchedAtMs = Date.now();
        if (this.leaseEpoch === snapshotEpoch) {
          this.sessionsSnapshot = {
            count: assignments.length,
            verified: true,
            accelerators: assignments.map((a) => a.accelerator).filter(Boolean),
            checkedAt: new Date().toISOString(),
          };
        }
        // 仅当当前查询账号与托管租约所属账号一致时，才用 assignments 核对或清空托管实例；
        // 绝不能拿新账号的空会话列表误判旧账号实例已停机，从而解除守护或丢弃回收记录。
        const stillSameLeaseAccount =
          sameLeaseAccount &&
          this.authStore.isCurrentAccount(String(this.settings.leaseAccountId || ""), this.lastApiKey || "");
        const matched = snapshotEndpoint && stillSameLeaseAccount
          ? assignments.find((a) => a.endpoint === snapshotEndpoint)
          : null;
        const hasBusyWork = Boolean(this.pumping || this.executingTask || this.queue.length > 0 || this.taskStore.findActiveTask());
        if (matched) {
          if (this.leaseEpoch === snapshotEpoch && this.settings.managedEndpoint === snapshotEndpoint) {
            this.activeAssignment = matched;
          }
        } else if (
          snapshotEndpoint &&
          stillSameLeaseAccount &&
          assignments.length === 0 &&
          !hasBusyWork &&
          this.leaseEpoch === snapshotEpoch &&
          this.settings.managedEndpoint === snapshotEndpoint
        ) {
          this.leaseEpoch += 1;
          this.activeAssignment = null;
          this.remoteState = null;
          this.#saveSettings({ managedEndpoint: "", leaseAccountId: "", idleDeadlineMs: 0, leaseOwnerPid: 0, leaseToken: "" });
          this.#clearIdleTimer();
          this.#disarmLeaseGuardian();
        }
      } catch {
        // 网络波动时保留上一次快照。
      }
    }

    const runningTask = this.taskStore.findActiveTask();
    const runtimeActive = Boolean(this.activeAssignment || this.settings.managedEndpoint);

    return {
      authUrl: buildGoogleAuthorizationUrl(),
      auth,
      settings: {
        gpuPreference: this.settings.gpuPreference,
        idleStopMinutes: this.settings.idleStopMinutes,
      },
      ccu: this.ccuSnapshot,
      sessions: this.sessionsSnapshot || {
        count: Number(this.ccuSnapshot?.assignmentsCount || 0),
        verified: false,
        accelerators: [],
        checkedAt: "",
      },
      runtime: runtimeActive
        ? {
            active: true,
            accelerator: this.activeAssignment?.accelerator || "GPU",
            endpoint: this.activeAssignment?.endpoint || this.settings.managedEndpoint,
            gpuName: this.remoteState?.gpu_name || this.activeAssignment?.accelerator || "GPU",
            vramUsedMib: this.remoteState?.vram_used_mib || 0,
            vramTotalMib: this.remoteState?.vram_total_mib || 0,
            diskFreeGb: this.remoteState?.disk_free_gb || 0,
            stage: this.remoteState?.stage || "ready",
            stageDetail: this.remoteState?.stage_detail || "云端显卡已连接",
            downloadProgress: this.remoteState?.download_progress || null,
          }
        : {
            active: false,
            accelerator: "",
            endpoint: "",
            stage: "stopped",
            stageDetail: "当前未开启云端显卡，不消耗计算单元",
            downloadProgress: null,
          },
      activeTask: runningTask
        ? {
            taskId: runningTask.taskId,
            model: runningTask.request?.model || "",
            status: runningTask.status,
            stageDetail: runningTask.stageDetail || "",
          }
        : null,
      queuedCount: this.queue.length,
      idleRemainingSeconds: this.idleDeadlineMs > Date.now()
        ? Math.max(0, Math.round((this.idleDeadlineMs - Date.now()) / 1000))
        : 0,
    };
  }

  async listModels(ctx = {}) {
    await this.ensureLocalServer();
    const incomingKey = String(ctx.config?.apiKey || "").trim();
    await this.#releaseManagedBeforeAccountSwitch(incomingKey, { signal: ctx.signal });
    const client = this.#createControlClient(ctx.config || {});
    // 读取模型时一并校验 Google 授权与 Colab 连通性；如果用户在 API Key 栏填了新授权码，这里一次性换取并保存。
    const ccu = await client.getConsumptionInfo({ signal: ctx.signal });
    this.ccuSnapshot = ccu;
    this.ccuFetchedAtMs = Date.now();
    ctx.log?.(`Google Colab 已连接，剩余计算单元 ${ccu.balance.toFixed(2)} CU`);
    return COLAB_MODELS.map(({ id, displayName, capability }) => ({ id, displayName, capability }));
  }

  async submitTask(request, ctx = {}) {
    return this.taskStore.runIdempotent(request?.extra?.idempotencyKey, (idemKey) =>
      this.#submitTaskImpl(request, ctx, idemKey),
    );
  }

  async #submitTaskImpl(request, ctx, idemKey) {
    await this.ensureLocalServer();

    const checked = validateGenerationRequest(request);
    if (!checked.ok) {
      return { status: "failed", message: checked.message };
    }

    const candidates = resolveAcceleratorCandidates(this.settings.gpuPreference, checked.modelSpec);
    if (candidates.length === 0) {
      return {
        status: "failed",
        message: `当前显卡偏好固定为 ${this.settings.gpuPreference}，无法运行「${checked.modelSpec.displayName}」。请在 Colab 插件面板将显卡档位改为「自动优选」或改用 MOSS-Image`,
      };
    }

    let origin;
    try {
      origin = normalizeColabOrigin(ctx.config?.baseUrl || this.settings.origin, {
        allowLoopbackOrigin: this.allowLoopbackOrigin,
      });
    } catch (error) {
      return { status: "failed", message: error.message };
    }
    if (origin !== this.settings.origin) {
      this.#saveSettings({ origin });
    }

    const incomingKey = String(ctx.config?.apiKey || "").trim();

    try {
      await this.#releaseManagedBeforeAccountSwitch(incomingKey, { signal: ctx.signal });
      if (incomingKey) this.#rememberSessionApiKey(incomingKey);
      await this.authStore.resolveAccessToken({
        apiKey: incomingKey || this.lastApiKey || "",
        signal: ctx.signal,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { status: "failed", message: error.message };
    }

    let inputImages = [];
    try {
      inputImages = await readReferenceImages(checked.images, {
        fetchImpl: this.fetchImpl,
        signal: ctx.signal,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { status: "failed", message: error.message };
    }

    const taskRecord = this.taskStore.createTask({
      idemKey,
      request,
      config: { baseUrl: origin, apiKey: incomingKey },
      modelSpec: checked.modelSpec,
      inputImages,
    });

    this.#clearIdleTimer();
    this.queue.push(taskRecord.taskId);
    void this.#pumpQueue().catch(() => {});

    return { taskId: taskRecord.taskId, status: "pending" };
  }

  async queryTask(taskId, _request, ctx = {}) {
    await this.ensureLocalServer();
    const task = this.taskStore.resolveForQuery(taskId);
    if (!task) {
      return { taskId, status: "failed", message: "找不到这条云端生图任务记录，可能插件进程已重启，请重新生成" };
    }

    if (task.stageDetail && task.stageDetail !== task.lastLoggedDetail) {
      task.lastLoggedDetail = task.stageDetail;
      ctx.log?.(task.stageDetail);
    }

    if (task.status === "succeeded") {
      return { taskId, status: "succeeded", result: task.result };
    }
    if (task.status === "failed") {
      return { taskId, status: "failed", message: task.message || "云端生图失败" };
    }
    return { taskId, status: task.status === "pending" ? "pending" : "processing" };
  }

  async #pumpQueue() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const nextId = this.queue.shift();
        const task = this.taskStore.getInMemory(nextId);
        if (!task || task.status === "failed" || task.status === "succeeded") continue;
        this.executingTask = true;
        try {
          await this.#executeTask(task);
        } finally {
          this.executingTask = false;
        }
      }
      if (
        this.settings.idleStopMinutes === 0 &&
        this.queue.length === 0 &&
        (this.activeAssignment || this.settings.managedEndpoint)
      ) {
        await this.stopRuntime({ releaseAll: false, onlyIfIdle: true }).catch(() => {});
      }
    } finally {
      this.pumping = false;
      if (this.queue.length > 0) {
        void this.#pumpQueue().catch(() => {});
      } else {
        this.#armIdleTimerIfIdle();
      }
    }
  }

  async #ensureRuntime(modelSpec, config) {
    return this.#runLeaseOp(async () => {
      const effectiveKey = String(config?.apiKey || this.lastApiKey || "").trim();
      // 若授权已通过外部路径（如直接调用 authStore.authorizeWithCode）切到新账号，
      // 先用旧账号凭证释放旧托管显卡，再在新账号下分配显卡，防止旧实例持续计费。
      if (
        this.settings.managedEndpoint &&
        this.settings.leaseAccountId &&
        !this.authStore.isCurrentAccount(this.settings.leaseAccountId, effectiveKey)
      ) {
        const prevControl = this.#createControlClient({
          baseUrl: config?.baseUrl,
          accountId: this.settings.leaseAccountId,
        });
        await prevControl.unassignRuntime(this.settings.managedEndpoint);
        this.leaseEpoch += 1;
        this.activeAssignment = null;
        this.remoteState = null;
        this.workerVerifiedAtMs = 0;
        this.#saveSettings({ managedEndpoint: "", leaseAccountId: "", idleDeadlineMs: 0, leaseOwnerPid: 0, leaseToken: "" });
        this.#disarmLeaseGuardian();
        this.authStore.pruneInactiveAccounts();
      }

      const control = this.#createControlClient(config);
      const candidates = resolveAcceleratorCandidates(this.settings.gpuPreference, modelSpec);

      const assignments = await control.listAssignments();
      const currentAccountId = this.authStore.getCurrentAccountId(effectiveKey);
      let existing = null;
      if (this.settings.managedEndpoint) {
        existing = assignments.find((a) => a.endpoint === this.settings.managedEndpoint) || null;
      }

      // 若上次插件持有的是 L4，但这次任务需要 G4/A100，先主动释放旧实例再申请高档位显卡。
      if (existing && !candidates.includes(existing.accelerator)) {
        await control.unassignRuntime(existing.endpoint);
        this.leaseEpoch += 1;
        this.#saveSettings({ managedEndpoint: "", leaseAccountId: "", idleDeadlineMs: 0, leaseOwnerPid: 0, leaseToken: "" });
        this.#disarmLeaseGuardian();
        this.activeAssignment = null;
        this.workerVerifiedAtMs = 0;
        existing = null;
      }

      if (!existing) {
        const assigned = await control.assignWithFallback({
          notebookHash: this.settings.notebookHash,
          candidates,
        });
        this.leaseEpoch += 1;
        this.activeAssignment = assigned;
        this.workerVerifiedAtMs = 0;
        this.sessionsSnapshot = {
          count: Math.max(1, Number(this.sessionsSnapshot?.count || 0)),
          verified: false,
          accelerators: [assigned.accelerator].filter(Boolean),
          checkedAt: "",
        };
        this.authStore.retainAccountForLease(currentAccountId, effectiveKey);
        this.#saveSettings({
          managedEndpoint: assigned.endpoint,
          leaseAccountId: currentAccountId,
          leaseOwnerPid: process.pid,
          leaseToken: randomUUID(),
        });
        this.#ensureLeaseGuardian();
        control.getConsumptionInfo().then((ccu) => {
          this.ccuSnapshot = ccu;
          this.ccuFetchedAtMs = Date.now();
        }).catch(() => {});
        return { control, assignment: assigned };
      }

      this.leaseEpoch += 1;
      this.activeAssignment = existing;
      const nextToken = this.settings.leaseToken || randomUUID();
      const resolvedLeaseAccountId = this.settings.leaseAccountId || currentAccountId;
      this.authStore.retainAccountForLease(resolvedLeaseAccountId, effectiveKey);
      this.#saveSettings({
        managedEndpoint: existing.endpoint,
        leaseAccountId: resolvedLeaseAccountId,
        leaseOwnerPid: process.pid,
        leaseToken: nextToken,
      });
      this.#ensureLeaseGuardian();
      return { control, assignment: existing };
    });
  }

  async #refreshProxyIfNeeded(control) {
    if (!this.activeAssignment) return null;
    if (this.activeAssignment.proxyExpiresAtMs - Date.now() > PROXY_REFRESH_MARGIN_MS) {
      return this.activeAssignment;
    }
    const list = await control.listAssignments();
    const refreshed = list.find((a) => a.endpoint === this.activeAssignment.endpoint);
    if (refreshed) {
      this.activeAssignment = refreshed;
    }
    return this.activeAssignment;
  }

  async #ensureRemoteWorker(proxyClient, task) {
    const existingState = await proxyClient.readJson(`${REMOTE_WORKER_ROOT}/state.json`);
    const nowSec = Date.now() / 1000;
    if (existingState && nowSec - Number(existingState.heartbeat_unix || 0) < WORKER_HEARTBEAT_STALE_SEC) {
      this.remoteState = existingState;
      this.workerVerifiedAtMs = Date.now();
      return existingState;
    }

    task.stageDetail = "正在初始化云端显卡工作进程";
    this.taskStore.persistSummary(task);

    const workerSource = Buffer.from(buildRemoteWorkerPythonSource(), "utf8");
    await proxyClient.uploadBytes(REMOTE_WORKER_SCRIPT, workerSource);
    await proxyClient.executeKernelCode(buildKernelLauncherCode(), { timeoutMs: 45000 });

    const deadline = Date.now() + this.workerReadyTimeoutMs;
    while (Date.now() < deadline) {
      const state = await proxyClient.readJson(`${REMOTE_WORKER_ROOT}/state.json`);
      if (state && Date.now() / 1000 - Number(state.heartbeat_unix || 0) < WORKER_HEARTBEAT_STALE_SEC) {
        this.remoteState = state;
        this.workerVerifiedAtMs = Date.now();
        return state;
      }
      await new Promise((r) => setTimeout(r, Math.min(400, this.pollIntervalMs)));
    }
    throw new Error("云端显卡工作进程未能及时就绪，请重试");
  }

  async #executeTask(task) {
    task.status = "processing";
    task.stageDetail = "正在连接并分配 Google Colab 云端显卡";
    this.taskStore.persistSummary(task);

    let proxyClient = null;
    const refFilenames = [];

    try {
      const { control, assignment } = await this.#ensureRuntime(task.modelSpec, task.config);
      task.stageDetail = `已连接 ${assignment.accelerator} 显卡，正在检查云端环境`;
      this.taskStore.persistSummary(task);

      proxyClient = new ColabRuntimeProxyClient({
        proxyUrl: assignment.proxyUrl,
        proxyToken: assignment.proxyToken,
        fetchImpl: this.fetchImpl,
        webSocketImpl: this.webSocketImpl,
      });

      const workerState = await this.#ensureRemoteWorker(proxyClient, task);
      const vramMib = Number(workerState?.vram_total_mib || 0);

      for (const img of task.inputImages) {
        const remoteName = `${task.taskId}_ref_${img.index + 1}.${img.ext}`;
        await proxyClient.uploadBytes(`${REMOTE_WORKER_ROOT}/inputs/${remoteName}`, img.body);
        refFilenames.push(remoteName);
      }
      task.inputImages = [];

      const plan = compileGenerationPlan(task.request, {
        modelSpec: task.modelSpec,
        accelerator: assignment.accelerator,
        vramMib,
        refFilenames,
      });

      await proxyClient.writeJson(`${REMOTE_WORKER_ROOT}/jobs/${task.taskId}.req.json`, {
        job_id: task.taskId,
        family: plan.modelSpec.family,
        weight_spec: plan.weightSpec,
        workflow: plan.graph,
        output_node_id: plan.outputNodeId,
        ref_files: refFilenames,
      });

      let lastFreshHeartbeatMs = Date.now();
      let consecutivePollErrors = 0;
      const jobDeadline = Date.now() + 25 * 60 * 1000;
      while (Date.now() < jobDeadline) {
        let state = null;
        let resJson = null;
        try {
          const freshAssignment = await this.#refreshProxyIfNeeded(control);
          if (freshAssignment) {
            proxyClient.updateProxy({
              proxyUrl: freshAssignment.proxyUrl,
              proxyToken: freshAssignment.proxyToken,
            });
          }

          [state, resJson] = await Promise.all([
            proxyClient.readJson(`${REMOTE_WORKER_ROOT}/state.json`),
            proxyClient.readJson(`${REMOTE_WORKER_ROOT}/jobs/${task.taskId}.res.json`),
          ]);
          consecutivePollErrors = 0;
        } catch (pollErr) {
          const status = Number(pollErr?.status || 0);
          const isNonTransient =
            status === 401 ||
            status === 403 ||
            (status >= 400 && status < 500 && status !== 408 && status !== 429) ||
            pollErr?.name === "AbortError" ||
            pollErr?.name === "SyntaxError";
          consecutivePollErrors += 1;
          if (isNonTransient) {
            throw pollErr;
          }
          if (Date.now() - lastFreshHeartbeatMs > this.heartbeatStaleWindowMs) {
            throw new Error("云端工作进程已停止响应（可能是显存不足被系统终止），请重试或切换更高显存显卡");
          }
          if (consecutivePollErrors >= 6) {
            throw pollErr;
          }
          await new Promise((r) => setTimeout(r, this.pollIntervalMs));
          continue;
        }

        if (state) {
          this.remoteState = state;
          if (state.active_job_id === task.taskId && state.stage_detail) {
            task.stageDetail = state.stage_detail;
          }
          const hbAgeSec = Date.now() / 1000 - Number(state.heartbeat_unix || 0);
          if (hbAgeSec <= WORKER_HEARTBEAT_STALE_SEC) {
            lastFreshHeartbeatMs = Date.now();
          }
        }
        if (!resJson && Date.now() - lastFreshHeartbeatMs > this.heartbeatStaleWindowMs) {
          throw new Error("云端工作进程已停止响应（可能是显存不足被系统终止），请重试或切换更高显存显卡");
        }

        if (resJson?.status === "failed") {
          throw new Error(resJson.message || "云端生图任务执行失败");
        }

        if (resJson?.status === "succeeded") {
          task.stageDetail = "云端已出图，正在取回无损原图";
          const outputs = Array.isArray(resJson.outputs) ? resJson.outputs : [];
          const images = [];
          const remoteOutNames = [];

          for (const outItem of outputs) {
            const fname = String(outItem?.filename || "");
            if (!fname) continue;
            remoteOutNames.push(fname);
            const pngBytes = await proxyClient.downloadBytes(`${REMOTE_WORKER_ROOT}/outputs/${fname}`);
            if (!pngBytes || pngBytes.length === 0) {
              throw new Error("取回云端原图失败，文件为空");
            }
            const mediaUrl = await this.localServer.registerOutputImage(pngBytes, fname);
            images.push({
              url: mediaUrl,
              name: fname,
              mimeType: "image/png",
              kind: "image",
              ephemeral: true,
            });
          }

          await this.#cleanupRemoteJobFiles(proxyClient, task.taskId, refFilenames, remoteOutNames);

          if (images.length === 0) {
            throw new Error("云端生图已完成，但没有取回到有效图片");
          }

          task.status = "succeeded";
          task.stageDetail = "已完成生图";
          task.result = { images, videos: [], audios: [] };
          this.taskStore.persistSummary(task);
          return;
        }

        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }

      throw new Error("云端生图任务等待超时（超过 25 分钟），请检查 Colab 实例状态后重试");
    } catch (error) {
      task.inputImages = [];
      if (proxyClient) {
        await this.#cleanupRemoteJobFiles(proxyClient, task.taskId, refFilenames, []).catch(() => {});
      }
      task.status = "failed";
      task.message = String(error?.message || "云端生图失败");
      task.stageDetail = task.message;
      this.taskStore.persistSummary(task);
    } finally {
      task.inputImages = [];
      task.config = null;
    }
  }

  async #cleanupRemoteJobFiles(proxyClient, jobId, refFilenames, outputFilenames) {
    const removals = [
      `${REMOTE_WORKER_ROOT}/jobs/${jobId}.res.json`,
      ...refFilenames.map((f) => `${REMOTE_WORKER_ROOT}/inputs/${f}`),
      ...outputFilenames.map((f) => `${REMOTE_WORKER_ROOT}/outputs/${f}`),
    ];
    await Promise.all(removals.map((p) => proxyClient.deletePath(p).catch(() => {})));
  }

  #clearIdleTimer({ persist = true } = {}) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleDeadlineMs = 0;
    if (persist && this.settings.idleDeadlineMs !== 0) {
      this.#saveSettings({ idleDeadlineMs: 0 });
    }
  }

  #armIdleTimerIfIdle(explicitDeadlineMs = 0) {
    this.#clearIdleTimer({ persist: false });
    if (this.pumping || this.queue.length > 0) return;
    if (!this.settings.managedEndpoint && !this.activeAssignment) return;
    const mins = Number(this.settings.idleStopMinutes);
    if (!Number.isFinite(mins) || mins < 0) {
      this.#saveSettings({ idleDeadlineMs: 0 });
      return;
    }

    const defaultDelayMs = mins === 0 ? this.immediateStopRetryMs : mins * 60 * 1000;
    const deadlineMs = explicitDeadlineMs > Date.now()
      ? explicitDeadlineMs
      : Date.now() + defaultDelayMs;
    const delayMs = Math.max(50, deadlineMs - Date.now());
    this.idleDeadlineMs = deadlineMs;
    this.#saveSettings({ idleDeadlineMs: deadlineMs });

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.idleDeadlineMs = 0;
      if (!this.executingTask && this.queue.length === 0) {
        void this.stopRuntime({ releaseAll: false, onlyIfIdle: true }).catch(() => {});
      }
    }, delayMs);
    this.idleTimer.unref?.();
  }

  async stopRuntime(options = {}) {
    return this.#runLeaseOp(() => this.#stopRuntimeLocked(options));
  }

  async #stopRuntimeLocked({ releaseAll = false, verifySessions = true, onlyIfIdle = false, signal } = {}) {
    if (onlyIfIdle && (this.executingTask || this.queue.length > 0)) {
      return;
    }
    this.#clearIdleTimer({ persist: false });
    const leaseAccountId = String(this.settings.leaseAccountId || "");
    const leaseIsOtherAccount = Boolean(
      leaseAccountId && !this.authStore.isCurrentAccount(leaseAccountId, this.lastApiKey || ""),
    );
    const currentControl = this.#createControlClient();
    const leaseControl = leaseIsOtherAccount
      ? this.#createControlClient({ accountId: leaseAccountId })
      : currentControl;

    const managedEndpoints = new Set();
    if (this.settings.managedEndpoint) managedEndpoints.add(this.settings.managedEndpoint);
    if (this.activeAssignment?.endpoint) managedEndpoints.add(this.activeAssignment.endpoint);

    const currentEndpoints = new Set();
    if (releaseAll) {
      const list = await currentControl.listAssignments({ signal });
      for (const item of list) {
        if (item.endpoint && (!leaseIsOtherAccount || !managedEndpoints.has(item.endpoint))) {
          currentEndpoints.add(item.endpoint);
        }
      }
    }

    const failed = [];
    for (const ep of managedEndpoints) {
      try {
        await leaseControl.unassignRuntime(ep, { signal });
      } catch (err) {
        failed.push({ endpoint: ep, err, message: err?.message || "释放失败" });
      }
    }
    for (const ep of currentEndpoints) {
      if (!leaseIsOtherAccount && managedEndpoints.has(ep)) continue;
      try {
        await currentControl.unassignRuntime(ep, { signal });
      } catch (err) {
        failed.push({ endpoint: ep, err, message: err?.message || "释放失败" });
      }
    }

    if (failed.length > 0) {
      this.#armIdleTimerIfIdle();
      const err = new Error(`释放云端显卡未成功（${failed[0].message}），计算单元可能仍在计费，请重试或前往 Colab 网页检查`);
      err.httpStatus = 502;
      if (failed[0].err?.code) err.code = failed[0].err.code;
      if (failed[0].err?.status) err.status = failed[0].err.status;
      throw err;
    }

    this.leaseEpoch += 1;
    this.activeAssignment = null;
    this.remoteState = null;
    this.workerVerifiedAtMs = 0;
    this.ccuFetchedAtMs = 0;
    this.#saveSettings({ managedEndpoint: "", leaseAccountId: "", idleDeadlineMs: 0, leaseOwnerPid: 0, leaseToken: "" });
    this.#disarmLeaseGuardian();
    this.authStore.pruneInactiveAccounts();

    if (verifySessions) {
      const verifyEpoch = this.leaseEpoch;
      try {
        const remaining = await currentControl.listAssignments({ signal });
        if (this.leaseEpoch === verifyEpoch) {
          this.sessionsSnapshot = {
            count: remaining.length,
            verified: true,
            accelerators: remaining.map((a) => a.accelerator).filter(Boolean),
            checkedAt: new Date().toISOString(),
          };
        }
      } catch {
        if (this.leaseEpoch === verifyEpoch) {
          this.sessionsSnapshot = null;
        }
      }
    }
  }
}
