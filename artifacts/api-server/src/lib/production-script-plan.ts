import type { ProductionScene } from "./production-types";
type Source = { summary: string; script: string; sourceMode?: "summary" | "script" };
const headings = () => /^\s*(?:SCENE\s+\d+\b[^\n]*|(?:INT|EXT|INT\/EXT|I\/E)\.[^\n]*)$/gim;
export const looksLikeScript = (value: string) => headings().test(value);
export function scriptSource(input: Source) {
  if (input.sourceMode === "script") return input.script.trim();
  if (input.sourceMode !== "summary" && input.script.trim()) return input.script.trim();
  return looksLikeScript(input.summary) ? input.summary.trim() : "";
}
const clock = (s: string) => s.split(":").reduce((n, part) => n * 60 + Number(part), 0);
export function parseAuthoredScenes(script: string): ProductionScene[] | null {
  const matches = [...script.matchAll(headings())];
  if (!matches.length) return null;
  return matches.map((match, i) => {
    const header = match[0].trim();
    const body = script.slice(match.index! + match[0].length, matches[i + 1]?.index ?? script.length).trim();
    const timing = header.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[–—-]\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
    const duration = timing ? clock(timing[2]) - clock(timing[1]) : undefined;
    if (duration !== undefined && (duration < 2 || duration > 5400)) throw new Error(`Scene ${i + 1} has an invalid time range.`);
    const title = header.replace(/^SCENE\s+\d+\s*[–—:.-]?\s*/i, "").replace(timing?.[0] ?? /$^/, "").trim();
    const location = title.split(/\s+[–—]\s+/)[0].replace(/\s*[–—-]\s*$/, "").trim() || "Unspecified location";
    const action: string[] = [], dialogue: string[] = [], characters = new Set<string>();
    let speaker: string | undefined;
    for (const line of body.split("\n")) {
      const direct = line.match(/^\s*([A-Z][A-Z .'-]{0,40}):\s*(.*)$/);
      if (direct) { characters.add(direct[1].trim()); dialogue.push(line); speaker = undefined; }
      else if (/^[A-Z][A-Z .'-]{0,30}$/.test(line.trim()) && line.trim().split(/\s+/).length <= 3 && !/^(CUT TO|FADE|SFX|B-ROLL)/.test(line.trim())) {
        speaker = line.trim(); characters.add(speaker); dialogue.push(`${speaker}:`);
      } else if (speaker && line.trim()) dialogue.push(line);
      else { action.push(line); if (!line.trim()) speaker = undefined; }
    }
    return {
      sceneNumber: i + 1, title: title.slice(0, 180) || `Scene ${i + 1}`,
      location: location.slice(0, 180), timeOfDay: header.match(/\b(NIGHT|DAY|MORNING|EVENING|DUSK|DAWN|AFTERNOON)\b/i)?.[1] ?? "Unspecified",
      characters: [...characters], action: action.join("\n").trim() || header, dialogue: dialogue.join("\n").trim(),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
    };
  });
}
export function sceneWritingSeconds(scene: ProductionScene, input: Source & { targetMinutes: number }, sceneCount: number) {
  if (!scriptSource(input)) return Math.ceil(input.targetMinutes * 60 / sceneCount);
  if (scene.durationSeconds !== undefined) return scene.durationSeconds;
  // Untimed scripts are estimated from their existing content, not padded to a preset.
  const words = scene.dialogue.replace(/^[A-Z][A-Z .'-]*:\s*/gm, "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(8, Math.ceil(words / 2.1 + scene.action.split(/\s+/).length / 12 * 3));
}
export function shotDurations(total: number, maximum: number) {
  const count = Math.ceil(total / maximum), durations = Array.from({ length: count }, () => maximum);
  durations[count - 1] = total - maximum * (count - 1);
  if (durations[count - 1] < 2 && count > 1) { durations[count - 2] -= 2 - durations[count - 1]; durations[count - 1] = 2; }
  if (durations.some(d => d < 2 || d > 30)) throw new Error("Scene timing cannot fit the selected shot length.");
  return durations;
}
