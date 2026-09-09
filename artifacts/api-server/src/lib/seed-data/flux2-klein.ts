type ApiWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
}>;

export type Flux2AssetKind = "character" | "setting";

export function createFlux2KleinWorkflow(input: {
  kind: Flux2AssetKind;
  prompt: string;
  seed: number;
}): ApiWorkflow {
  const width = input.kind === "character" ? 768 : 1344;
  const height = input.kind === "character" ? 1024 : 768;
  const prefix = input.kind === "character"
    ? "image/OBTV_Character"
    : "image/OBTV_Setting";

  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "flux-2-klein-4b.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_3_4b.safetensors",
        type: "flux2",
        device: "default",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "flux2-vae.safetensors" },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
    },
    "6": {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "7": {
      class_type: "Flux2Scheduler",
      inputs: { steps: 4, width, height },
    },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler" },
    },
    "9": {
      class_type: "CFGGuider",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        cfg: 1,
      },
    },
    "10": {
      class_type: "RandomNoise",
      inputs: { noise_seed: input.seed },
    },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["10", 0],
        guider: ["9", 0],
        sampler: ["8", 0],
        sigmas: ["7", 0],
        latent_image: ["6", 0],
      },
    },
    "12": {
      class_type: "VAEDecode",
      inputs: { samples: ["11", 0], vae: ["3", 0] },
    },
    "13": {
      class_type: "SaveImage",
      inputs: { images: ["12", 0], filename_prefix: prefix },
    },
  };
}