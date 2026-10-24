/** Remove only the legacy auto-appended story, retaining authored shot corrections. */
export function productionShotPrompt(prompt: string, storySummary: string): string {
  const summary = storySummary.replace(/\r\n?/g, "\n").trim();
  if (!summary) return prompt;
  const suffix = `\n\nPROJECT VISUAL DIRECTION\n${summary}`;
  return prompt.replace(suffix, "").trim();
}
