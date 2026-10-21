import type { ProductionProject } from "@workspace/api-client-react";
import { normalizeState, type Story, type ProductionSettings } from "./production-types";

export type ProductionDraft = { title: string; step: number; story: Pick<Story, "summary" | "script" | "targetMinutes" | "scenes" | "sourceMode">; settings: ProductionSettings };
export function draftFrom(p: ProductionProject): ProductionDraft {
  const s = normalizeState(p.state as Record<string, unknown>);
  return { title: p.title, step: s.step, story: { summary: s.story.summary, script: s.story.script, targetMinutes: s.story.targetMinutes, scenes: s.story.scenes, sourceMode: s.story.sourceMode }, settings: s.settings };
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function sameDraftValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameDraftValue(v, b[i]));
  if (record(a) && record(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => sameDraftValue(a[k], b[k]));
  return false;
}
export class ProductionDraftConflict extends Error {
  constructor(field: string) { super(`“${field}” was also edited elsewhere. Your edits are still here.`); }
}
/** Merge local edits onto fresh server data; never silently replace a competing edit. */
export function rebaseDraft(base: ProductionDraft, local: ProductionDraft, remote: ProductionDraft, keepLocal = false): ProductionDraft {
  function merge(b: unknown, l: unknown, r: unknown, path: string): unknown {
    if (sameDraftValue(l, b)) return r;
    if (sameDraftValue(l, r) || sameDraftValue(r, b)) return l;
    if (record(l) && record(r) && (record(b) || b === undefined)) {
      const keys = new Set([...Object.keys(record(b) ? b : {}), ...Object.keys(l), ...Object.keys(r)]);
      return Object.fromEntries([...keys].map(k => [k, merge(record(b) ? b[k] : undefined, l[k], r[k], path ? `${path}.${k}` : k)]));
    }
    if (keepLocal) return l;
    throw new ProductionDraftConflict(path);
  }
  return merge(base, local, remote, "") as ProductionDraft;
}
/** Arrays are atomic; generated fields absent from the editable draft are never sent. */
export function draftPatch(remote: ProductionDraft, merged: ProductionDraft): { title?: string; state: Record<string, unknown> } {
  function diff(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.keys(b).filter(k => !sameDraftValue(a[k], b[k])).map(k => [k, record(a[k]) && record(b[k]) ? diff(a[k], b[k]) : b[k]]));
  }
  const { title, ...state } = diff(remote as unknown as Record<string, unknown>, merged as unknown as Record<string, unknown>);
  return { ...(title !== undefined ? { title: title as string } : {}), state };
}
