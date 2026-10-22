// Adapters that map the two character-look sources (library look batches and production
// snapshots) onto one slot model so both screens render the same look UI.
export type SlotState = "READY" | "PENDING" | "FAILED" | "EMPTY";
export interface LookSlot { key: string; state: SlotState; assetId?: string; mediaUrl?: string; label?: string; error?: string }

type BatchSlot = { index: number; status: string; assetId?: string | null; mediaUrl?: string | null; error?: string | null; view?: string | null };
const PENDING = new Set(["QUEUED", "RUNNING", "PENDING", "ACTIVE", "SUBMITTED", "PROCESSING", "GENERATING"]);

function slotState(status: string | undefined, hasMedia: boolean): SlotState {
  const s = (status ?? "").toUpperCase();
  if (hasMedia && (s === "READY" || s === "COMPLETED" || s === "")) return "READY";
  if (s === "FAILED" || s === "ERROR") return "FAILED";
  if (PENDING.has(s)) return "PENDING";
  return hasMedia ? "READY" : "EMPTY";
}

/** Library look batch (server-owned, durable) to four slots. */
export function slotsFromBatch(batch: { slots: BatchSlot[] } | null | undefined, count = 4): LookSlot[] {
  return Array.from({ length: count }, (_, i) => {
    const s = batch?.slots[i];
    if (!s) return { key: `empty-${i}`, state: "EMPTY" as const };
    const media = !!(s.assetId && s.mediaUrl);
    return { key: s.assetId ?? `slot-${i}`, state: slotState(s.status, media), assetId: s.assetId ?? undefined, mediaUrl: s.mediaUrl ?? undefined, label: s.view ?? undefined, error: s.error ?? undefined };
  });
}

/** Production snapshot options to four slots; while generating, missing slots show progress. */
export function slotsFromProduction(c: { options: { assetId: string; mediaUrl: string }[]; status: string }, count = 4): LookSlot[] {
  const generating = PENDING.has((c.status ?? "").toUpperCase());
  const failed = ["FAILED", "ERROR"].includes((c.status ?? "").toUpperCase());
  if (generating) return Array.from({ length: count }, (_, i) => ({ key: `pending-${i}`, state: "PENDING" as const }));
  const filled: LookSlot[] = c.options.map((o) => ({ key: o.assetId, state: "READY" as const, assetId: o.assetId, mediaUrl: o.mediaUrl }));
  while (filled.length < count) filled.push({ key: `empty-${filled.length}`, state: failed ? "FAILED" : "EMPTY" });
  return filled;
}

/** Production reference sheet (ready images only) to slots. */
export function slotsFromSheet(refs: { assetId: string; mediaUrl: string; label?: string }[]): LookSlot[] {
  return refs.map((r) => ({ key: r.assetId, state: "READY" as const, assetId: r.assetId, mediaUrl: r.mediaUrl, label: r.label }));
}

/** Name derived from the prompt; matches the server's fallback (first clause, up to six words). */
export function deriveCharacterName(prompt: string, maxWords = 6): string {
  const firstClause = prompt.trim().split(/[,.;\n]/)[0] ?? "";
  const words = firstClause.replace(/^(an?|the)\s+/i, "").split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 60) || "Untitled character";
}

export const CHARACTER_CHIPS = ["age", "hair", "build", "eye colour", "clothing", "personality"];
export function appendChip(prompt: string, chip: string): string {
  return `${prompt}${prompt && !prompt.endsWith("\n") ? "\n" : ""}${chip}: `;
}
