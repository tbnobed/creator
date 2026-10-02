import { isDeepStrictEqual } from "node:util";
import { createLtx25T2vWorkflow, ltx25T2vMappings, ltx25T2vSeed } from "./ltx-25";

// Do not replace imported or customized graphs with the app's seed.
export function upgradeLegacyLtxFps(row: {
  name: string;
  modelFamily: string;
  generationMode: string;
  mappings: unknown;
  apiWorkflow: unknown;
}) {
  if (row.name !== ltx25T2vSeed.name || row.modelFamily !== "LTX 2.5"
    || row.generationMode !== ltx25T2vSeed.generationMode
    || !isDeepStrictEqual(row.mappings, ltx25T2vMappings)) return null;
  const legacy = createLtx25T2vWorkflow();
  legacy["33"].class_type = "PrimitiveInt";
  return isDeepStrictEqual(row.apiWorkflow, legacy) ? createLtx25T2vWorkflow() : null;
}