// BeefTV Google Colab 生成接口：
// 平时保持 0 计算单元待机；画布发起生成时自动分配云端显卡、按需拉取模型权重并回传无损原图；
// 闲置满设定时长或退出 BeefTV 时自动释放云端实例。

import { ColabSessionManager } from "./lib/session-manager.mjs";

export function createColabProvider(options = {}) {
  const manager = new ColabSessionManager(options);
  return {
    manager,
    async models(ctx = {}) {
      return manager.listModels(ctx);
    },
    async submit(request, ctx = {}) {
      return manager.submitTask(request, ctx);
    },
    async query(taskId, request, ctx = {}) {
      return manager.queryTask(taskId, request, ctx);
    },
  };
}

let defaultProvider = null;

function sharedProvider() {
  if (!defaultProvider) {
    defaultProvider = createColabProvider({ installExitHooks: true });
  }
  return defaultProvider;
}

/** @type {NonNullable<import("@beeftv/plugin-sdk").ProviderModule["models"]>} */
export async function models(ctx) {
  return sharedProvider().models(ctx);
}

/** @type {import("@beeftv/plugin-sdk").ProviderModule["submit"]} */
export async function submit(request, ctx) {
  return sharedProvider().submit(request, ctx);
}

/** @type {import("@beeftv/plugin-sdk").ProviderModule["query"]} */
export async function query(taskId, request, ctx) {
  return sharedProvider().query(taskId, request, ctx);
}
