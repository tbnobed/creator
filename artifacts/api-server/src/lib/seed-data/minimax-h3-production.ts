import { createMiniMaxH3R2vWorkflow, miniMaxH3R2vSeed, r2vMappings } from "./minimax-h3-r2v";

/** Native keyframe guide, separate from all appearance-reference inputs. */
export function createMiniMaxH3ProductionWorkflow(blackwell: boolean) {
  const variant = blackwell ? miniMaxH3R2vSeed.blackwell : miniMaxH3R2vSeed.a100;
  const graph = createMiniMaxH3R2vWorkflow(variant.clipName, variant.unetName);
  graph["140"] = { class_type: "LoadImage", inputs: { image: "production-first-frame.png" } };
  graph["141"] = {
    class_type: "MiniMaxH3AddGuide",
    inputs: {
      positive: ["136", 0], latent: ["136", 1], vae: ["119", 0],
      image: ["140", 0], frame_idx: 0,
    },
  };
  graph["126"].inputs.conditioning = ["141", 0];
  graph["142"] = { class_type: "LoadImage", inputs: { image: "production-reference-3.png" } };
  graph["136"].inputs["ref_images.ref_image_2"] = ["142", 0];
  graph["92"].inputs.filename_prefix = "video/MiniMax_H3_Production";
  return graph;
}

export const productionMappings = {
  ...r2vMappings,
  firstFrame: { nodeId: "140", input: "image" },
  referenceImage3: { nodeId: "142", input: "image" },
};
