type ApiWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
}>;

const baseWorkflow: ApiWorkflow = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 0,
      steps: 20,
      cfg: 5,
      sampler_name: "uni_pc",
      scheduler: "simple",
      denoise: 1,
      model: ["48", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["55", 0],
    },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "Describe the video to generate.", clip: ["38", 0] },
  },
  "7": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "blurry, distorted, low quality, artifacts, static, subtitles, watermark",
      clip: ["38", 0],
    },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["3", 0], vae: ["39", 0] },
  },
  "37": {
    class_type: "UNETLoader",
    inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" },
  },
  "38": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      type: "wan",
      device: "default",
    },
  },
  "39": {
    class_type: "VAELoader",
    inputs: { vae_name: "wan2.2_vae.safetensors" },
  },
  "48": {
    class_type: "ModelSamplingSD3",
    inputs: { model: ["37", 0], shift: 8 },
  },
  "55": {
    class_type: "Wan22ImageToVideoLatent",
    inputs: {
      vae: ["39", 0],
      width: 1280,
      height: 704,
      length: ["61", 1],
      batch_size: 1,
    },
  },
  "57": {
    class_type: "CreateVideo",
    inputs: { images: ["8", 0], fps: 24, bit_depth: 8 },
  },
  "58": {
    class_type: "SaveVideo",
    inputs: {
      video: ["57", 0],
      filename_prefix: "video/Wan_2.2_TI2V_5B",
      format: "auto",
      codec: "auto",
    },
  },
  "60": {
    class_type: "PrimitiveInt",
    inputs: { value: 120 },
  },
  "61": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "round(a / 4) * 4 + 1", "values.a": ["60", 0] },
  },
};

export const wan22T2vMappings = {
  prompt: { nodeId: "6", input: "text" },
  negativePrompt: { nodeId: "7", input: "text" },
  width: { nodeId: "55", input: "width" },
  height: { nodeId: "55", input: "height" },
  frames: { nodeId: "60", input: "value" },
  fps: { nodeId: "57", input: "fps" },
  seed: { nodeId: "3", input: "seed" },
};

export const wan22I2vMappings = {
  ...wan22T2vMappings,
  referenceImage1: { nodeId: "56", input: "image" },
};

export function createWan22T2vWorkflow(): ApiWorkflow {
  return structuredClone(baseWorkflow);
}

export function createWan22I2vWorkflow(): ApiWorkflow {
  const workflow = createWan22T2vWorkflow();
  workflow["56"] = {
    class_type: "LoadImage",
    inputs: { image: "reference-image.png" },
  };
  workflow["55"].inputs.start_image = ["56", 0];
  return workflow;
}

export const wan22Seeds = {
  t2v: {
    name: "Wan 2.2 TI2V 5B — Text to Video",
    description: "Official Wan 2.2 5B silent text-to-video generation at 24 fps.",
    generationMode: "wan22-t2v",
  },
  i2v: {
    name: "Wan 2.2 TI2V 5B — Image to Video",
    description: "Official Wan 2.2 5B silent image-to-video generation at 24 fps.",
    generationMode: "wan22-i2v",
  },
  tags: ["wan-2.2", "a100"],
} as const;