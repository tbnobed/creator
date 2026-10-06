/** Single-pass app limits, not a claim about arbitrary custom workflow capacity. */
export function localVideoDurationLimit(modelFamily: string, fps = 24): number {
  const family = modelFamily.toLowerCase();
  if (family.includes("wan")) return Math.min(5, Math.floor(121 / Math.max(1, fps)));
  if (family.includes("minimax") || family.includes("h3")) return 15;
  if (family.includes("ltx")) return fps > 25 ? 10 : 20;
  return 5;
}
