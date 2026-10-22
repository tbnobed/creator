import { useState } from "react";
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListSettingsQueryKey, type SettingReferencesItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/shared/confirm";
import { ErrorNotice, readableError } from "@/components/shared/error-notice";
import { deleteLocationReference, renameLocationReference } from "./location-api";

/** Library reference management. Edits apply to the shared library only; productions keep their imported snapshot. */
export function LocationReferences({ settingId, references }: { settingId: string; references: SettingReferencesItem[] }) {
  const queryClient = useQueryClient();
  const confirmAction = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });

  const rename = async (id: string) => {
    if (!draft.trim()) return;
    setBusy(id); setError(null);
    try { await renameLocationReference(settingId, id, draft.trim()); setEditing(null); await refresh(); }
    catch (e) { setError(readableError(e, "The reference could not be renamed.")); }
    finally { setBusy(null); }
  };
  const remove = async (ref: SettingReferencesItem) => {
    if (!(await confirmAction({ title: `Remove “${ref.name}” from this location?`, description: "Productions that already imported this location keep their own copy.", confirmLabel: "Remove", destructive: true }))) return;
    setBusy(ref.id); setError(null);
    try { await deleteLocationReference(settingId, ref.id); await refresh(); }
    catch (e) { setError(readableError(e, "The reference could not be removed.")); }
    finally { setBusy(null); }
  };

  if (references.length === 0) return <p className="text-xs text-muted-foreground" data-testid="text-no-references">No reference images yet.</p>;
  return (
    <div className="space-y-2" data-testid="list-location-references">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {references.map((ref) => (
          <figure key={ref.id} className="min-w-0" data-testid={`card-reference-${ref.id}`}>
            <a href={ref.url} target="_blank" rel="noreferrer"><img src={ref.url} alt={ref.name} loading="lazy" className="aspect-video w-full rounded object-cover" /></a>
            {ref.unavailableReason && <p role="alert" className="mt-1 text-xs text-destructive">{ref.unavailableReason}</p>}
            {editing === ref.id ? (
              <div className="mt-1 flex gap-1">
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" aria-label="Reference name" data-testid={`input-rename-reference-${ref.id}`} />
                <Button size="icon" variant="ghost" className="size-7" aria-label="Save name" disabled={busy === ref.id} onClick={() => void rename(ref.id)} data-testid={`button-save-reference-${ref.id}`}>{busy === ref.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}</Button>
                <Button size="icon" variant="ghost" className="size-7" aria-label="Cancel rename" onClick={() => setEditing(null)}><X className="size-3" /></Button>
              </div>
            ) : (
              <figcaption className="mt-1 flex items-center gap-1">
                <span className="flex-1 truncate text-xs" title={ref.prompt}>{ref.name}</span>
                <Button size="icon" variant="ghost" className="size-6" aria-label={`Rename ${ref.name}`} onClick={() => { setEditing(ref.id); setDraft(ref.name); }} data-testid={`button-rename-reference-${ref.id}`}><Pencil className="size-3" /></Button>
                <Button size="icon" variant="ghost" className="size-6 hover:text-destructive" aria-label={`Remove ${ref.name}`} disabled={busy === ref.id} onClick={() => void remove(ref)} data-testid={`button-delete-reference-${ref.id}`}><Trash2 className="size-3" /></Button>
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {error && <ErrorNotice testId="status-reference-error" message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}
