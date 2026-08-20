type ApiWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
}>;

const blackwellTextEncoder = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";

const baseWorkflow: ApiWorkflow = {
  "92": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/MiniMax_H3",
      format: "auto",
      codec: "auto",
      video: ["130", 0],
    },
  },
  "115": {
    class_type: "ResolutionSelector",
    inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.4, multiple: 32 },
  },
  "119": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
  },
  "120": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
  },
  "121": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["125", 0], vae: ["120", 0] },
  },
  "122": {
    class_type: "VAEDecode",
    inputs: { samples: ["125", 0], vae: ["119", 0] },
  },
  "123": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
  },
  "124": {
    class_type: "BasicScheduler",
    inputs: { scheduler: "simple", steps: ["142", 0], denoise: 1, model: ["127", 0] },
  },
  "125": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["129", 0],
      guider: ["126", 0],
      sampler: ["123", 0],
      sigmas: ["124", 0],
      latent_image: ["136", 1],
    },
  },
  "126": {
    class_type: "BasicGuider",
    inputs: { model: ["141", 0], conditioning: ["136", 0] },
  },
  "127": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
  },
  "128": {
    class_type: "CLIPLoader",
    inputs: { clip_name: blackwellTextEncoder, type: "minimax", device: "default" },
  },
  "129": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 261662374822964 },
  },
  "130": {
    class_type: "CreateVideo",
    inputs: { fps: 24, bit_depth: 8, images: ["122", 0], audio: ["121", 0] },
  },
  "131": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["132", 0],
    },
  },
  "132": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
  },
  "136": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      prompt: ["138", 0],
      width: ["115", 0],
      height: ["115", 1],
      length: ["131", 1],
      ref_image_size: "match",
      clip: ["128", 0],
      vae: ["119", 0],
      audio_vae: ["120", 0],
      "ref_images.ref_image_0": ["137", 0],
      "ref_images.ref_image_1": ["139", 0],
    },
  },
  "137": {
    class_type: "LoadImage",
    inputs: { image: "reference-character-1.png" },
  },
  "138": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "Describe the shot to generate." },
  },
  "139": {
    class_type: "LoadImage",
    inputs: { image: "reference-character-2.png" },
  },
  "141": {
    class_type: "ComfySwitchNode",
    inputs: { switch: ["146", 0], on_false: ["127", 0], on_true: ["145", 0] },
  },
  "142": {
    class_type: "ComfySwitchNode",
    inputs: { switch: ["146", 0], on_false: ["143", 0], on_true: ["144", 0] },
  },
  "143": {
    class_type: "PrimitiveInt",
    inputs: { value: 20 },
  },
  "144": {
    class_type: "PrimitiveInt",
    inputs: { value: 4 },
  },
  "145": {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      lora_name: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      strength_model: 1,
      model: ["127", 0],
    },
  },
  "146": {
    class_type: "PrimitiveBoolean",
    inputs: { value: false },
  },
};

export const r2vMappings = {
  prompt: { nodeId: "138", input: "value" },
  width: { nodeId: "136", input: "width" },
  height: { nodeId: "136", input: "height" },
  durationSeconds: { nodeId: "132", input: "value" },
  fps: { nodeId: "130", input: "fps" },
  seed: { nodeId: "129", input: "noise_seed" },
  referenceImage1: { nodeId: "137", input: "image" },
  referenceImage2: { nodeId: "139", input: "image" },
};

export const r2vVideoMappings = {
  prompt: { nodeId: "138", input: "value" },
  width: { nodeId: "136", input: "width" },
  height: { nodeId: "136", input: "height" },
  durationSeconds: { nodeId: "132", input: "value" },
  fps: { nodeId: "130", input: "fps" },
  seed: { nodeId: "129", input: "noise_seed" },
  referenceVideo: { nodeId: "152", input: "file" },
};

export function createMiniMaxH3R2vWorkflow(clipName: string): ApiWorkflow {
  const workflow = structuredClone(baseWorkflow);
  workflow["128"].inputs["clip_name"] = clipName;
  return workflow;
}

export function createMiniMaxH3R2vVideoWorkflow(clipName: string): ApiWorkflow {
  const workflow = createMiniMaxH3R2vWorkflow(clipName);
  workflow["92"].inputs["video-preview"] = "";
  workflow["115"].inputs.megapixels = 1;
  workflow["132"].inputs.value = 16;
  delete workflow["136"].inputs["ref_images.ref_image_0"];
  delete workflow["136"].inputs["ref_images.ref_image_1"];
  delete workflow["137"];
  delete workflow["139"];
  workflow["136"].inputs["ref_videos.ref_video_0"] = ["153", 0];
  workflow["136"].inputs["ref_video_audios.ref_video_audio_0"] = ["153", 1];
  workflow["152"] = {
    class_type: "LoadVideo",
    inputs: { file: "reference-presenter.mp4", "video-preview": "" },
  };
  workflow["153"] = {
    class_type: "GetVideoComponents",
    inputs: { video: ["152", 0] },
  };
  return workflow;
}

export const miniMaxH3R2vSeed = {
  a100: {
    name: "MiniMax H3 REF2VA (A100)",
    description: "MiniMax H3 reference-image video generation for NVIDIA A100 workers using the INT8 ConvRot text encoder.",
    tags: ["minimax-h3", "a100"],
    clipName: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
  },
  blackwell: {
    name: "MiniMax H3 REF2VA",
    description: "MiniMax H3 reference-image video generation for Blackwell workers using the NVFP4 AWQ text encoder.",
    tags: ["minimax-h3", "blackwell"],
    clipName: blackwellTextEncoder,
  },
} as const;

export const miniMaxH3R2vVideoSeed = {
  a100: {
    name: "MiniMax H3 REF2VA Video (A100)",
    description: "MiniMax H3 presenter-video reference generation for NVIDIA A100 workers. The uploaded video supplies the reference video and audio.",
    tags: ["minimax-h3", "a100"],
    clipName: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
  },
  blackwell: {
    name: "MiniMax H3 REF2VA Video (Blackwell)",
    description: "MiniMax H3 presenter-video reference generation for Blackwell workers. The uploaded video supplies the reference video and audio.",
    tags: ["minimax-h3", "blackwell"],
    clipName: blackwellTextEncoder,
  },
} as const;