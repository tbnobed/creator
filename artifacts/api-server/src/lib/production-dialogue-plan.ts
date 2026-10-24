/** Authored speech is data, not text for a model to rewrite. */
export function planAuthoredDialogue(dialogue: string, total: number, preferred: number) {
  const words: { speaker: string; word: string }[] = [];
  let speaker = "";
  for (const line of dialogue.split("\n")) {
    if (/^\s*\([^)]*\)\s*$/.test(line)) continue;
    const match = line.match(/^\s*([A-Z][A-Z .'-]*):\s*(.*)$/);
    if (match) speaker = match[1].trim();
    for (const word of (match ? match[2] : line).trim().split(/\s+/).filter(Boolean)) words.push({ speaker, word });
  }
  const capacity = (seconds: number) => Math.max(0, Math.floor((seconds - 2) * 2.1));
  const weight = (word: string) => word.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  // Keep the requested shot count when feasible. Longer takes avoid paying
  // the speech lead/trailing allowance again every five seconds.
  for (let count = Math.ceil(total / preferred); count >= Math.ceil(total / 30); count--) {
    const base = Math.floor(total / count);
    const durations = Array.from({ length: count }, (_, i) =>
      base + Math.max(0, Math.min(1, total - base * count - i)));
    if (durations.some(d => d < 2 || d > 30)) continue;
    let offset = 0;
    const planned = durations.map(durationSeconds => {
      const start = offset;
      let used = 0;
      while (offset < words.length && used + weight(words[offset].word) <= capacity(durationSeconds)) {
        used += weight(words[offset++].word);
      }
      const slice = words.slice(start, offset);
      const lines: string[] = [];
      let lastSpeaker: string | undefined;
      for (const entry of slice) {
        if (entry.speaker !== lastSpeaker) {
          lines.push(`${entry.speaker ? `${entry.speaker}: ` : ""}${entry.word}`);
          lastSpeaker = entry.speaker;
        } else lines[lines.length - 1] += ` ${entry.word}`;
      }
      return { durationSeconds, dialogue: lines.join("\n") };
    });
    if (offset === words.length) return planned;
  }
  throw new Error(`The authored dialogue cannot fit this scene's ${total}-second timing at a natural speaking pace. Increase its time range or shorten its dialogue; no words were removed.`);
}
