/** Pure helpers for the simplified Create/Edit Location dialog. */
export const SHORT_DESCRIPTION_MAX = 160;

/** Derive a one-line card summary from the shared prompt (first sentence, word-safe, ≤ max chars). */
export function deriveShortDescription(prompt: string, max = SHORT_DESCRIPTION_MAX): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "")}…`;
}

/** True when an existing location carries a summary the user wrote separately from its prompt. */
export function hasDistinctShortDescription(description?: string | null, prompt?: string | null): boolean {
  const d = (description ?? "").trim();
  return !!d && d !== (prompt ?? "").trim() && d !== deriveShortDescription(prompt ?? "");
}

/** Short description to persist: keep a distinct existing one, otherwise derive from the prompt. */
export function resolveShortDescription(prompt: string, preserved: string | null): string {
  const kept = preserved?.trim();
  return kept ? kept : deriveShortDescription(prompt);
}

export function parseTags(raw: string): string[] {
  return Array.from(new Set(raw.split(",").map((t) => t.trim()).filter(Boolean)));
}

/** A blank dialog thumbnail must not clear a newer server-generated image. */
export function locationThumbnailInput(thumbnail: string): { thumbnail?: string } {
  return thumbnail ? { thumbnail } : {};
}
