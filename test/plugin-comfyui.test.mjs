import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkflowParameters,
  inputTargets,
  missingNodeTypes,
  needsObjectInfo,
  outputNodeIds,
  prepareWorkflow,
  randomizeSeeds,
  setInput,
  workflowOutputKind,
} from "../plugins/beeftv-plugin-comfyui/lib/workflow.mjs";
import { convertEditorGraph } from "../plugins/beeftv-plugin-comfyui/lib/editor.mjs";
import { models, query, submit } from "../plugins/beeftv-plugin-comfyui/provider.mjs";

const BASIC_API_GRAPH = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "2": { class_type: "CLIPTextEncode", _meta: { title: "正向提示词" }, inputs: { text: "old positive", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", _meta: { title: "反向提示词" }, inputs: { text: "bad anatomy", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "5": {
    class_type: "KSampler",
    inputs: {
      seed: 123,
      steps: 20,
      cfg: 7,
      model: ["1", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
    },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "out" } },
};

test("workflowOutputKind & inputTargets pick positive prompt, loaders, outputs, and randomize seeds", () => {
  assert.equal(workflowOutputKind(BASIC_API_GRAPH), "image");
  assert.equal(needsObjectInfo(BASIC_API_GRAPH), false);
  const prepared = prepareWorkflow(BASIC_API_GRAPH, null);
  const targets = inputTargets(prepared);
  assert.deepEqual(targets.prompt, { nodeId: "2", widget: "text" });
  assert.deepEqual(outputNodeIds(prepared), ["7"]);

  setInput(prepared.graph, targets.prompt, "cinematic portrait");
  assert.equal(prepared.graph["2"].inputs.text, "cinematic portrait");

  randomizeSeeds(prepared, () => 0.5);
  assert.notEqual(prepared.graph["5"].inputs.seed, 123);

  applyWorkflowParameters(prepared, {});
  assert.equal(prepared.graph["4"].inputs.width, 512);
  assert.equal(prepared.graph["4"].inputs.height, 512);

  applyWorkflowParameters(prepared, {
    aspectRatio: "16:9",
    resolution: "720p",
  });
  assert.equal(prepared.graph["4"].inputs.width, 1280);
  assert.equal(prepared.graph["4"].inputs.height, 720);

  const exactImgPrepared = prepareWorkflow(BASIC_API_GRAPH, null);
  applyWorkflowParameters(exactImgPrepared, { resolution: "1920x1080" });
  assert.equal(exactImgPrepared.graph["4"].inputs.width, 1920);
  assert.equal(exactImgPrepared.graph["4"].inputs.height, 1080);

  const hostPixelAspectImg = prepareWorkflow(BASIC_API_GRAPH, null);
  applyWorkflowParameters(hostPixelAspectImg, { aspectRatio: "1824x1024", resolution: "auto", capability: "image" });
  assert.equal(hostPixelAspectImg.graph["4"].inputs.width, 1824);
  assert.equal(hostPixelAspectImg.graph["4"].inputs.height, 1024);

  const hostExactAspectImg = prepareWorkflow(BASIC_API_GRAPH, null);
  applyWorkflowParameters(hostExactAspectImg, { aspectRatio: "1920x1080", capability: "image" });
  assert.equal(hostExactAspectImg.graph["4"].inputs.width, 1920);
  assert.equal(hostExactAspectImg.graph["4"].inputs.height, 1080);

  for (const [tier, wantW, wantH] of [
    ["1k", 1824, 1024],
    ["2k", 2752, 1536],
    ["4k", 3840, 2160],
  ]) {
    const tierPrepared = prepareWorkflow(BASIC_API_GRAPH, null);
    applyWorkflowParameters(tierPrepared, { aspectRatio: "16:9", resolution: tier, capability: "image" });
    assert.equal(tierPrepared.graph["4"].inputs.width, wantW, `image tier ${tier} width`);
    assert.equal(tierPrepared.graph["4"].inputs.height, wantH, `image tier ${tier} height`);
  }

  const sd3Graph = structuredClone(BASIC_API_GRAPH);
  sd3Graph["4"].class_type = "EmptySD3LatentImage";
  const sd3Prepared = prepareWorkflow(sd3Graph, null);
  applyWorkflowParameters(sd3Prepared, { aspectRatio: "1920x1080", capability: "image" });
  assert.deepEqual([sd3Prepared.graph["4"].inputs.width, sd3Prepared.graph["4"].inputs.height], [1920, 1088]);

  const ltxPrepared = prepareWorkflow(
    { "1": { class_type: "EmptyLTXVLatentVideo", inputs: { width: 768, height: 512, length: 49 } }, "2": { class_type: "SaveVideo", inputs: { video: ["1", 0] } } },
    null,
  );
  applyWorkflowParameters(ltxPrepared, { resolution: "1808x1024", capability: "video" });
  assert.deepEqual([ltxPrepared.graph["1"].inputs.width, ltxPrepared.graph["1"].inputs.height], [1824, 1024]);

  const customStepPrepared = prepareWorkflow(BASIC_API_GRAPH, {
    EmptyLatentImage: { input: { required: { width: ["INT", { step: 64 }], height: ["INT", { step: 64 }] } } },
  });
  applyWorkflowParameters(customStepPrepared, { aspectRatio: "1808x1024", capability: "image" });
  assert.deepEqual([customStepPrepared.graph["4"].inputs.width, customStepPrepared.graph["4"].inputs.height], [1792, 1024]);

  const appModeImg = prepareWorkflow(BASIC_API_GRAPH, null);
  appModeImg.appMode = { inputs: [{ nodeId: "2", widget: "text" }], outputNodeIds: ["7"] };
  applyWorkflowParameters(appModeImg, { aspectRatio: "16:9", resolution: "720p" });
  assert.equal(appModeImg.graph["4"].inputs.width, 512);
  assert.equal(appModeImg.graph["4"].inputs.height, 512);

  const videoPrepared = prepareWorkflow(
    {
      "1": { class_type: "WanImageToVideo", inputs: { width: 832, height: 480, length: 81 } },
      "2": { class_type: "SaveVideo", inputs: { video: ["1", 0] } },
    },
    null,
  );
  applyWorkflowParameters(videoPrepared, { aspectRatio: "16:9", resolution: "720p", duration: 5 });
  assert.equal(videoPrepared.graph["1"].inputs.width, 1280);
  assert.equal(videoPrepared.graph["1"].inputs.height, 720);
});

test("regression: SamplerCustomAdvanced with BasicGuider resolves positive prompt node", () => {
  const graph = {
    "10": { class_type: "UNETLoader", inputs: { unet_name: "flux.safetensors" } },
    "11": { class_type: "CLIPTextEncode", _meta: { title: "Prompt" }, inputs: { text: "initial", clip: ["1", 0] } },
    "12": { class_type: "BasicGuider", inputs: { model: ["10", 0], conditioning: ["11", 0] } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["15", 0], sigmas: ["16", 0], latent_image: ["17", 0] } },
    "18": { class_type: "SaveImage", inputs: { images: ["14", 0] } },
  };
  const targets = inputTargets(prepareWorkflow(graph, null));
  assert.deepEqual(targets.prompt, { nodeId: "11", widget: "text" });
});

test("regression: subgraph LLM qwen3.5_9b upsampler resolves upstream top-level 提示词 node (#28) instead of subgraph instruction widget (#127:108)", () => {
  const graph = {
    "28": {
      class_type: "PrimitiveStringMultiline",
      _meta: { title: "提示词" },
      inputs: { value: "用户原始提示词" },
    },
    "127:10": {
      class_type: "Qwen3Loader",
      _meta: { title: "qwen3.5_9b" },
      inputs: { system_prompt: "You are a prompt upsampler", instruction: "Rewrite vividly" },
    },
    "127:108": {
      class_type: "PrimitiveStringMultiline",
      _meta: { title: "extra_prompt" },
      inputs: { value: "", prompt: ["28", 0] },
    },
    "127:115": {
      class_type: "TextPromptUpsampler",
      inputs: { model: ["127:10", 0], user_prompt: ["127:108", 0], text: "" },
    },
    "127:120": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Positive" },
      inputs: { text: ["127:115", 0], clip: ["1", 0] },
    },
    "127:125": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Negative" },
      inputs: { text: "blurry", clip: ["1", 0] },
    },
    "128": {
      class_type: "CFGGuider",
      inputs: { positive: ["127:120", 0], negative: ["127:125", 0] },
    },
    "129": {
      class_type: "SamplerCustomAdvanced",
      inputs: { guider: ["128", 0], noise: ["5", 0] },
    },
    "130": { class_type: "SaveImage", inputs: { images: ["129", 0] } },
  };
  const targets = inputTargets(prepareWorkflow(graph, null));
  assert.deepEqual(targets.prompt, { nodeId: "28", widget: "value" });
});

test("regression: ConditioningZeroOut fallback does not poison reachable positive CLIPTextEncode when positive uses ConditioningCombine", () => {
  const graph = {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "hero shot", clip: ["1", 0] } },
    "7": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    "8": { class_type: "ConditioningCombine", inputs: { conditioning_1: ["6", 0], conditioning_2: ["6", 0] } },
    "9": { class_type: "KSampler", inputs: { seed: 1, positive: ["8", 0], negative: ["7", 0], latent_image: ["4", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
  };
  const targets = inputTargets(prepareWorkflow(graph, null));
  assert.deepEqual(targets.prompt, { nodeId: "6", widget: "text" });
});

test("regression: unreachable titled prompt node never overrides output-reachable prompt in multi-sampler workflows", () => {
  const graph = {
    "2": { class_type: "CLIPTextEncode", inputs: { text: "USED", clip: ["1", 0] } },
    "3": { class_type: "KSampler", inputs: { seed: 1, positive: ["2", 0], negative: ["4", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "neg", clip: ["1", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "6": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    "8": { class_type: "CLIPTextEncode", _meta: { title: "提示词" }, inputs: { text: "UNUSED-TITLED", clip: ["1", 0] } },
    "9": { class_type: "KSampler", inputs: { seed: 2, positive: ["8", 0], negative: ["4", 0], latent_image: ["5", 0] } },
  };
  const targets = inputTargets(prepareWorkflow(graph, null));
  assert.deepEqual(targets.prompt, { nodeId: "2", widget: "text" });
});

test("editor format conversion handles PrimitiveNode, Reroute, Set/Get wireless nodes, dynamic combo, and missingNodeTypes", () => {
  const editorGraph = {
    nodes: [
      { id: 1, type: "PrimitiveNode", pos: [0, 0], size: [200, 100], outputs: [{ name: "STRING", type: "STRING", links: [10] }], widgets_values: ["a dog on the beach"] },
      { id: 10, type: "Reroute", pos: [150, 0], size: [80, 40], inputs: [{ name: "", type: "*", link: 10 }], outputs: [{ name: "", type: "*", links: [12] }] },
      { id: 11, type: "SetNode", pos: [200, 120], size: [120, 60], inputs: [{ name: "STRING", type: "STRING", link: 12 }], widgets_values: ["promptVar"] },
      { id: 12, type: "GetNode", pos: [250, 120], size: [120, 60], outputs: [{ name: "STRING", type: "STRING", links: [13] }], widgets_values: ["promptVar"] },
      { id: 2, type: "CLIPTextEncode", pos: [300, 0], size: [200, 100], inputs: [{ name: "text", type: "STRING", link: 13, widget: { name: "text" } }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [11] }], widgets_values: [""] },
      { id: 4, type: "DynamicVideoModel", pos: [300, 200], size: [220, 140], outputs: [{ name: "VIDEO", type: "VIDEO", links: [14] }], widgets_values: ["fast_mode", "9:16", 1280, 720, "after-ui-slot"] },
      { id: 3, type: "SaveVideo", pos: [600, 0], size: [200, 100], inputs: [{ name: "video", type: "VIDEO", link: 14 }], widgets_values: ["Out"] },
    ],
    links: [
      [10, 1, 0, 10, 0, "STRING"],
      [12, 10, 0, 11, 0, "STRING"],
      [13, 12, 0, 2, 0, "STRING"],
      [11, 2, 0, 3, 0, "CONDITIONING"],
      [14, 4, 0, 3, 0, "VIDEO"],
    ],
  };
  const objectInfo = {
    CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], upload_tag: ["IMAGEUPLOAD"] } } },
    DynamicVideoModel: {
      input: {
        required: {
          model: [
            "COMFY_DYNAMICCOMBO_V3",
            {
              options: [
                {
                  key: "fast_mode",
                  inputs: {
                    required: {
                      aspect_ratio: ["COMBO", { options: ["16:9", "9:16", "1:1"] }],
                      width: ["INT", { default: 832 }],
                      height: ["INT", { default: 480 }],
                    },
                  },
                },
              ],
            },
          ],
          audio_preview: ["AUDIOUI"],
          upload_ui: ["IMAGEUPLOAD"],
          trailing_note: ["STRING", { default: "" }],
        },
      },
    },
    SaveVideo: { input: { required: { video: ["VIDEO"], filename_prefix: ["STRING", { default: "ComfyUI" }] } } },
    EmptyHunyuanLatentVideo: {
      input: { required: { width: ["INT", { default: 720 }], height: ["INT", { default: 1280 }], length: ["INT", { default: 25 }] } },
    },
  };
  assert.deepEqual(missingNodeTypes(editorGraph, objectInfo), []);
  const converted = convertEditorGraph(editorGraph, objectInfo);
  assert.equal(converted.graph["2"].inputs.text, "a dog on the beach");
  assert.equal(converted.graph["4"].inputs.trailing_note, "after-ui-slot");
  assert.deepEqual(converted.comboOptions["4.model.aspect_ratio"], ["16:9", "9:16", "1:1"]);

  const prepared = prepareWorkflow(editorGraph, objectInfo);
  applyWorkflowParameters(prepared, { aspectRatio: "16:9" });
  assert.equal(prepared.graph["4"].inputs["model.aspect_ratio"], "16:9");

  const exactResPrepared = prepareWorkflow(editorGraph, objectInfo);
  applyWorkflowParameters(exactResPrepared, { aspectRatio: "9:16", resolution: "1920x1080" });
  assert.equal(exactResPrepared.graph["4"].inputs["model.aspect_ratio"], "16:9");

  const constrainedObjectInfo = structuredClone(objectInfo);
  constrainedObjectInfo.DynamicVideoModel.input.required.model[1].options[0].inputs.required.aspect_ratio = [
    "COMBO",
    { options: ["9:16", "1:1"] },
  ];
  const videoLatentEditor = {
    nodes: [
      { id: 4, type: "DynamicVideoModel", pos: [0, 0], size: [220, 140], outputs: [{ name: "VIDEO", type: "VIDEO", links: [1] }], widgets_values: ["fast_mode", "9:16", 832, 480, "note"] },
      { id: 5, type: "EmptyHunyuanLatentVideo", pos: [300, 0], size: [220, 140], outputs: [{ name: "LATENT", type: "LATENT", links: [2] }], widgets_values: [720, 1280, 25] },
      { id: 3, type: "SaveVideo", pos: [600, 0], size: [200, 100], inputs: [{ name: "video", type: "VIDEO", link: 1 }, { name: "latent", type: "LATENT", link: 2 }], widgets_values: ["Out"] },
    ],
    links: [
      [1, 4, 0, 3, 0, "VIDEO"],
      [2, 5, 0, 3, 1, "LATENT"],
    ],
  };
  const acceptedExact = prepareWorkflow(videoLatentEditor, objectInfo);
  applyWorkflowParameters(acceptedExact, { aspectRatio: "9:16", resolution: "1920x1080", capability: "video" });
  assert.equal(acceptedExact.graph["4"].inputs["model.aspect_ratio"], "16:9");
  assert.equal(acceptedExact.graph["5"].inputs.width, 1920);
  assert.equal(acceptedExact.graph["5"].inputs.height, 1088);

  const rejectedExact = prepareWorkflow(videoLatentEditor, constrainedObjectInfo);
  applyWorkflowParameters(rejectedExact, { resolution: "1920x1080", capability: "video" });
  assert.equal(rejectedExact.graph["4"].inputs["model.aspect_ratio"], "9:16");
  assert.equal(rejectedExact.graph["5"].inputs.width, 1088);
  assert.equal(rejectedExact.graph["5"].inputs.height, 1920);
});

test("provider submit/query/models work with mocked fetch", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/api/userdata/workflows%2Fdemo.json")) {
        return new Response(JSON.stringify(BASIC_API_GRAPH), { status: 200 });
      }
      if (target.includes("/api/userdata?dir=workflows")) {
        return new Response(JSON.stringify(["demo.json"]), { status: 200 });
      }
      if (target.endsWith("/api/prompt")) {
        return new Response(JSON.stringify({ prompt_id: "job-1" }), { status: 200 });
      }
      if (target.endsWith("/api/history/job-1")) {
        return new Response(
          JSON.stringify({
            "job-1": {
              status: { status_str: "success", completed: true },
              outputs: { "7": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const ctx = { config: { baseUrl: "http://127.0.0.1:8188" }, log: () => {} };
    const list = await models(ctx);
    assert.equal(list[0].id, "demo.json");

    const submitted = await submit({ model: "demo.json", prompt: "neon samurai" }, ctx);
    assert.deepEqual(submitted, { taskId: "job-1", status: "pending" });

    const queried = await query("job-1", {}, ctx);
    assert.equal(queried.status, "succeeded");
    assert.equal(queried.result.images.length, 1);
    assert.match(queried.result.images[0].url, /filename=out\.png/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
