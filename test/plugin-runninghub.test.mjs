import assert from "node:assert/strict";
import test from "node:test";

import { appTargets, workflowTargets } from "../plugins/beeftv-plugin-runninghub/lib/targets.mjs";
import { models, parseModel, query, submit } from "../plugins/beeftv-plugin-runninghub/provider.mjs";

test("parseModel handles workflow IDs, app prefixes, and web URLs", () => {
  assert.deepEqual(parseModel("1904123456"), { kind: "workflow", id: "1904123456" });
  assert.deepEqual(parseModel("app:987654"), { kind: "app", id: "987654" });
  assert.deepEqual(parseModel("https://www.runninghub.cn/ai-detail/555666"), { kind: "app", id: "555666" });
  assert.deepEqual(parseModel("https://www.runninghub.cn/workflow/777888"), { kind: "workflow", id: "777888" });
  assert.throws(() => parseModel("bad-model"), /RunningHub/);
});

test("workflowTargets and appTargets locate prompt, media, and seed slots", () => {
  const targets = workflowTargets({
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "old" } },
    "3": { class_type: "KSampler", inputs: { positive: ["2", 0], seed: 99 } },
  });
  assert.deepEqual(targets.prompt, { nodeId: "2", fieldName: "text" });
  assert.deepEqual(targets.media.image, [{ nodeId: "1", fieldName: "image" }]);
  assert.deepEqual(targets.seeds, [{ nodeId: "3", fieldName: "seed" }]);

  const app = appTargets([
    { nodeId: "10", fieldName: "prompt", fieldType: "STRING" },
    { nodeId: "11", fieldName: "image", fieldType: "IMAGE" },
  ]);
  assert.deepEqual(app.prompt, { nodeId: "10", fieldName: "prompt" });
  assert.deepEqual(app.media.image, [{ nodeId: "11", fieldName: "image" }]);
});

test("provider models error, submit task, and query normalizes legacy output domain", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/api/openapi/getJsonApiFormat")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { prompt: JSON.stringify({ "2": { class_type: "CLIPTextEncode", inputs: { text: "init" } } }) },
          }),
          { status: 200 },
        );
      }
      if (target.endsWith("/task/openapi/create")) {
        return new Response(JSON.stringify({ code: 0, data: { taskId: "rh-123" } }), { status: 200 });
      }
      if (target.endsWith("/task/openapi/outputs")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: [{ fileUrl: "https://rh-images-1252422369.cos.ap-beijing.myqcloud.com/output/test.png", fileType: "png" }],
          }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const ctx = { config: { apiKey: "secret-key", baseUrl: "https://www.runninghub.cn" } };
    await assert.rejects(() => models(ctx), /RunningHub 不提供工作流列表/);

    const sub = await submit({ model: "123456", prompt: "sunrise" }, ctx);
    assert.deepEqual(sub, { taskId: "rh-123", status: "pending" });

    const out = await query("rh-123", {}, ctx);
    assert.equal(out.status, "succeeded");
    assert.equal(out.result.images[0].url, "https://rh-images.xiaoyaoyou.com/output/test.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
