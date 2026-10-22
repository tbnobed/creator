// Browser drafts are scoped to the signed-in user and active workspace so switching
// workspaces never restores another workspace's prompt, characters or uploads.
let scope = "anonymous";

export function setStorageScope(userId: string | undefined, tenantId: string | undefined): void {
  scope = `${userId ?? "anonymous"}:${tenantId ?? "none"}`;
}

export function scopedKey(base: string): string {
  return `${base}:${scope}`;
}

/** Minimal storage surface so legacy-draft logic is testable without a browser. */
export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** Bases that were stored unscoped before drafts were separated per workspace. */
export const LEGACY_DRAFT_BASES = ["obtv.composerDraft", "obtv.referenceVideo"] as const;

/** Legacy unscoped drafts still waiting for an explicit import or discard. */
export function pendingLegacyDrafts(store: KeyStore, bases: readonly string[] = LEGACY_DRAFT_BASES): string[] {
  return bases.filter((b) => store.getItem(b) !== null);
}

/**
 * Explicit, user-initiated: copy legacy drafts into the current workspace scope (replacing that
 * workspace's draft, which the notice states), then remove the legacy copies so no other workspace sees them.
 */
export function importLegacyDrafts(store: KeyStore, bases: readonly string[] = LEGACY_DRAFT_BASES): number {
  const pending = pendingLegacyDrafts(store, bases);
  for (const b of pending) { store.setItem(scopedKey(b), store.getItem(b)!); store.removeItem(b); }
  return pending.length;
}

export function discardLegacyDrafts(store: KeyStore, bases: readonly string[] = LEGACY_DRAFT_BASES): void {
  for (const b of bases) store.removeItem(b);
}
