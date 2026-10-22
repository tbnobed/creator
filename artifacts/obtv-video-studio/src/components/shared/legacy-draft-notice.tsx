import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { discardLegacyDrafts, importLegacyDrafts, pendingLegacyDrafts } from "@/lib/workspace-storage";

function store() { try { return window.localStorage; } catch { return null; } }

/** Offers an explicit import of drafts saved before per-workspace scoping. Nothing is restored without a click. */
export function LegacyDraftNotice({ workspaceName }: { workspaceName?: string }) {
  const [pending, setPending] = useState(() => { const s = store(); return s ? pendingLegacyDrafts(s) : []; });
  if (pending.length === 0) return null;
  return (
    <div role="status" className="mx-4 mt-3 mb-1 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm" data-testid="notice-legacy-draft">
      <History className="size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">An unsaved draft from before drafts were kept per workspace was found. It is not loaded unless you import it{workspaceName ? ` into ${workspaceName}` : ""}; importing replaces this workspace’s current draft.</p>
      <Button size="sm" onClick={() => { const s = store(); if (s) importLegacyDrafts(s); window.location.reload(); }} data-testid="button-import-legacy-draft">Import into this workspace</Button>
      <Button size="sm" variant="ghost" onClick={() => { const s = store(); if (s) discardLegacyDrafts(s); setPending([]); }} data-testid="button-discard-legacy-draft">Discard</Button>
    </div>
  );
}
