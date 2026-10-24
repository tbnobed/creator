import { writeFileSync } from "node:fs";
import { createMiniMaxH3R2vWorkflow } from "../artifacts/api-server/src/lib/seed-data/minimax-h3-r2v";
import { createFlux2KleinWorkflow } from "../artifacts/api-server/src/lib/seed-data/flux2-klein";

const h3 = createMiniMaxH3R2vWorkflow("qwen3vl_32b_minimax_h3_int8_convrot.safetensors");
for (const id of ["115", "131", "132", "137", "139"]) delete h3[id];
delete h3["136"].inputs["ref_images.ref_image_0"];
delete h3["136"].inputs["ref_images.ref_image_1"];
Object.assign(h3["136"].inputs, { width: 640, height: 384, length: 124 });
h3["138"].inputs.value = "A red wooden ball resting on a gray studio floor. Locked camera. Quiet room.";
h3["92"].inputs.filename_prefix = "diagnostics/swap-probe/h3";
const flux = createFlux2KleinWorkflow({ kind: "setting", prompt: "A red wooden ball resting on a gray studio floor.", seed: 541 });
Object.assign(flux["6"].inputs, { width: 640, height: 384 });
Object.assign(flux["7"].inputs, { width: 640, height: 384 });
flux["13"].inputs.filename_prefix = "diagnostics/swap-probe/flux";
writeFileSync("/tmp/h100-swap-graphs.json", JSON.stringify({ h3, flux }));
