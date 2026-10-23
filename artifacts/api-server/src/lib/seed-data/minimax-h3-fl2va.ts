import { createMiniMaxH3R2vWorkflow, r2vMappings } from "./minimax-h3-r2v";

export const fl2vaMappings = {
  prompt: r2vMappings.prompt,
  width: r2vMappings.width,
  height: r2vMappings.height,
  durationSeconds: r2vMappings.durationSeconds,
  fps: r2vMappings.fps,
  seed: r2vMappings.seed,
  firstFrame: { nodeId: "137", input: "image" },
  lastFrame: { nodeId: "139", input: "image" },
};

/** Native keyframes, not REF2VA appearance references. Optional loaders are
 * removed by buildWorkflow when their corresponding frame is not supplied. */
export function createMiniMaxH3Fl2vaWorkflow(blackwell: boolean) {
  const graph = createMiniMaxH3R2vWorkflow(
    blackwell ? "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" : "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    blackwell ? "minimax_h3_fl2va_pruned_nvfp4.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  );
  graph["136"].class_type = "MiniMaxH3ImageToVideo";
  delete graph["136"].inputs.ref_image_size;
  delete graph["136"].inputs.audio_vae;
  delete graph["136"].inputs["ref_images.ref_image_0"];
  delete graph["136"].inputs["ref_images.ref_image_1"];
  graph["136"].inputs.first_frame = ["137", 0];
  graph["136"].inputs.last_frame = ["139", 0];
  graph["92"].inputs.filename_prefix = "video/MiniMax_H3_FL2VA";
  return graph;
}

export function isEmptyFl2vaPlaceholder(workflow: {
  name: string; modelFamily: string; apiWorkflow: unknown; mappings: unknown;
}) {
  return workflow.name === "MiniMax H3 FL2VA"
    && workflow.modelFamily === "MiniMax H3"
    && (!workflow.apiWorkflow || Object.keys(workflow.apiWorkflow).length === 0)
    && (!workflow.mappings || Object.keys(workflow.mappings).length === 0);
}
