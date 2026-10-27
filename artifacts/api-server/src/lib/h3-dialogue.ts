/** Speaker labels are metadata, never part of H3's spoken <d> payload. */
export type H3DialogueTurn = { speakerIndex: number | null; text: string; voiceover?: true };

export function h3DialogueTurns(dialogue: string, names: string[]): H3DialogueTurn[] | null {
  const normalize = (s: string) => s.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const resolve = (label: string) => {
    const exact = names.map((n, i) => normalize(n) === normalize(label) ? i : -1).filter(i => i >= 0);
    if (exact.length === 1) return exact[0];
    const first = names.map((n, i) => normalize(n).split(" ")[0] === normalize(label) ? i : -1).filter(i => i >= 0);
    return first.length === 1 ? first[0] : null;
  };
  const turns: H3DialogueTurn[] = [];
  let labeled = false;
  // Some older drafts put several screenplay turns on one line.
  const aliases = [...new Set(names.flatMap(n => [n, n.split(" ")[0]]))];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = aliases.length
    ? dialogue.replace(new RegExp(`([.!?…]["']?)[ \\t]+((?:${aliases.map(escape).join("|")})\\s*:)`, "gi"), "$1\n$2")
    : dialogue;
  for (const raw of normalized.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^\([^)]*\)$/.test(line)) continue;
    const match = line.match(/^([^:\n]{1,80}):\s*(.*)$/u);
    const index = match ? resolve(match[1].replace(/\s*\([^)]*\)\s*$/, "")) : null;
    const voiceover = match && /^(?:narrator|narration|voice[- ]?over|v\.?o\.?)$/i.test(match[1].trim());
    if (voiceover) {
      labeled = true;
      turns.push({ speakerIndex: null, text: match![2], voiceover: true });
      continue;
    }
    if (match && (index !== null || /^[\p{Lu}\d .’'-]+$/u.test(match[1]))) {
      if (index === null) throw new Error(`Dialogue speaker "${match[1]}" does not match a selected character. Assign that character before rendering; speaker names will not be read aloud.`);
      labeled = true;
      turns.push({ speakerIndex: index, text: match[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += ` ${line}`;
    } else {
      turns.push({ speakerIndex: null, text: line });
    }
  }
  return labeled ? turns.filter(t => t.text.trim()) : null;
}

