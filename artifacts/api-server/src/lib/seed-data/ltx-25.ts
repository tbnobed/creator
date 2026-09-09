type ApiWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
}>;

const baseWorkflow: ApiWorkflow = {
  "1": {
    class_type: "UnetLoaderGGUF",
    inputs: { unet_name: "LTX-2.5-Distilled-Q6_K.gguf" },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
      type: "ltxv",
      device: "default",
    },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "Describe the video and its synchronized sound.", clip: ["2", 0] },
  },
  "4": {
    class_type: "CLIPTextEncode",
    inputs: {
      text: "pc game, console game, video game, cartoon, childish, ugly, subtitles, watermark",
      clip: ["2", 0],
    },
  },
  "5": {
    class_type: "LTXVConditioning",
    inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: ["33", 0] },
  },
  "6": {
    class_type: "VAELoader",
    inputs: { vae_name: "ltx-2.5-video-vae-bf16.safetensors" },
  },
  "7": {
    class_type: "VAELoader",
    inputs: { vae_name: "ltx-2.5-audio-vae-bf16.safetensors" },
  },
  "8": {
    class_type: "EmptyLTXVLatentVideo",
    inputs: {
      width: ["34", 1],
      height: ["35", 1],
      length: ["36", 1],
      batch_size: 1,
    },
  },
  "9": {
    class_type: "LTXVEmptyLatentAudio",
    inputs: {
      frames_number: ["36", 1],
      frame_rate: ["33", 0],
      batch_size: 1,
      audio_vae: ["7", 0],
    },
  },
  "10": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["8", 0], audio_latent: ["9", 0] },
  },
  "11": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "euler_ancestral" },
  },
  "12": {
    class_type: "ManualSigmas",
    inputs: { sigmas: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" },
  },
  "13": {
    class_type: "LTXVDualCFGGuider",
    inputs: {
      model: ["1", 0],
      positive: ["5", 0],
      negative: ["5", 1],
      video_cfg: 1,
      audio_cfg: 1,
    },
  },
  "14": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 0 },
  },
  "15": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["14", 0],
      guider: ["13", 0],
      sampler: ["11", 0],
      sigmas: ["12", 0],
      latent_image: ["10", 0],
    },
  },
  "16": {
    class_type: "LTXVSeparateAVLatent",
    inputs: { av_latent: ["15", 0] },
  },
  "17": {
    class_type: "LatentUpscaleModelLoader",
    inputs: { model_name: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" },
  },
  "18": {
    class_type: "LTXVLatentUpsampler",
    inputs: { samples: ["16", 0], upscale_model: ["17", 0], vae: ["6", 0] },
  },
  "19": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["18", 0], audio_latent: ["16", 1] },
  },
  "20": {
    class_type: "ManualSigmas",
    inputs: { sigmas: "0.85, 0.7250, 0.4219, 0.0" },
  },
  "21": {
    class_type: "LTXVDualCFGGuider",
    inputs: {
      model: ["1", 0],
      positive: ["5", 0],
      negative: ["5", 1],
      video_cfg: 1,
      audio_cfg: 1,
    },
  },
  "22": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["14", 0],
      guider: ["21", 0],
      sampler: ["11", 0],
      sigmas: ["20", 0],
      latent_image: ["19", 0],
    },
  },
  "23": {
    class_type: "LTXVSeparateAVLatent",
    inputs: { av_latent: ["22", 0] },
  },
  "24": {
    class_type: "VAEDecodeTiled",
    inputs: {
      samples: ["23", 0],
      vae: ["6", 0],
      tile_size: 512,
      overlap: 64,
      temporal_size: 64,
      temporal_overlap: 16,
    },
  },
  "25": {
    class_type: "LTXVAudioVAEDecode",
    inputs: { samples: ["23", 1], audio_vae: ["7", 0] },
  },
  "26": {
    class_type: "CreateVideo",
    inputs: { images: ["24", 0], audio: ["25", 0], fps: ["33", 0], bit_depth: 8 },
  },
  "27": {
    class_type: "SaveVideo",
    inputs: {
      video: ["26", 0],
      filename_prefix: "video/LTX_2.5_GGUF",
      format: "auto",
      codec: "auto",
    },
  },
  "30": {
    class_type: "PrimitiveInt",
    inputs: { value: 1280 },
  },
  "31": {
    class_type: "PrimitiveInt",
    inputs: { value: 720 },
  },
  "32": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
  },
  "33": {
    class_type: "PrimitiveInt",
    inputs: { value: 24 },
  },
  "34": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "a / 2", "values.a": ["30", 0] },
  },
  "35": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "a / 2", "values.a": ["31", 0] },
  },
  "36": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "round((a * b) / 8) * 8 + 1",
      "values.a": ["32", 0],
      "values.b": ["33", 0],
    },
  },
};

export const ltx25T2vMappings = {
  prompt: { nodeId: "3", input: "text" },
  negativePrompt: { nodeId: "4", input: "text" },
  width: { nodeId: "30", input: "value" },
  height: { nodeId: "31", input: "value" },
  durationSeconds: { nodeId: "32", input: "value" },
  fps: { nodeId: "33", input: "value" },
  seed: { nodeId: "14", input: "noise_seed" },
};

export function createLtx25T2vWorkflow(): ApiWorkflow {
  return structuredClone(baseWorkflow);
}

export const ltx25T2vSeed = {
  name: "LTX 2.5 Distilled Q6 GGUF — Text to Video + Audio",
  description: "LTX 2.5 GGUF text-to-video with synchronized generated audio and a two-stage latent detail pass.",
  generationMode: "ltx25-t2v",
  tags: ["ltx-2.5", "a100"],
} as const;