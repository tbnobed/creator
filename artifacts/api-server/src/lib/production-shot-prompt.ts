import { text } from "./production-types";

/** An unchanged re-render must not append empty instructions or truncate the prompt. */
export function productionRerenderPrompt(prompt: string, correction?: unknown): string {
  const instruction = text(correction ?? "", "Correction", 5000, false);
  return instruction ? `${prompt}\nCorrection: ${instruction}`.slice(0, 20000) : prompt;
}

/** Preserve initial production seeds, but avoid an identical deterministic retry. */
export function productionRetrySeed(seed: number, retryCount: number): number {
  return retryCount > 0 ? (seed + retryCount) % 4294967296 : seed;
}

/** Remove only the legacy auto-appended story, retaining authored shot corrections. */
export function productionShotPrompt(prompt: string, storySummary: string): string {
  const summary = storySummary.replace(/\r\n?/g, "\n").trim();
  if (!summary) return prompt;
  const suffix = `\n\nPROJECT VISUAL DIRECTION\n${summary}`;
  return prompt.replace(suffix, "").trim();
}
