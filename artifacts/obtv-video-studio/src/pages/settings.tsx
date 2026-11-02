import { FileDropzone } from "@/components/shared/file-dropzone";
import { useState, useRef } from "react";
import { useListSettings, useDeleteSetting, useCreateSetting, useUpdateSetting } from "@workspace/api-client-react";
import { getListSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Edit2, Trash2, Map, Image as ImageIcon, Sparkles, Upload, ChevronDown } from "lucide-react";
import type { Setting } from "@workspace/api-client-react";
import { deriveShortDescription, hasDistinctShortDescription, locationThumbnailInput, parseTags, resolveShortDescription, SHORT_DESCRIPTION_MAX } from "@/lib/location-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { LocationImageJob } from "@/components/locations/LocationImageJob";
import { LocationReferences } from "@/components/locations/LocationReferences";
import { ErrorNotice } from "@/components/shared/error-notice";
import { useConfirm } from "@/components/shared/confirm";

export default function SettingsPage() {
  const { data: settings, isLoading, isError, refetch } = useListSettings({ query: { queryKey: getListSettingsQueryKey(), staleTime: 0, refetchOnMount: "always", refetchInterval: 15000 } });
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteSetting();
  const { toast } = useToast();

  const confirmAction = useConfirm();
  const handleDelete = async (id: string) => {
    if (await confirmAction({ title: "Delete this location?", description: "It is removed from Locations & Scenery. Productions that already imported it keep their own snapshot.", confirmLabel: "Delete", destructive: true })) {
      try {
        await deleteMutation.mutateAsync({ id });
        queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
      } catch (error) {
        toast({ title: "Location not deleted", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
      }
    }
  };

  return (
    <Page>
      <PageHeader
        title="Locations & Scenery"
        description="Manage reusable locations and environments for your scenes."
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2" data-testid="button-new-location">
                <Plus className="size-4" />
                New Location
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[100dvh] overflow-y-auto sm:max-w-[560px]">
              <DialogHeader>
                <DialogTitle>Create Location</DialogTitle>
              </DialogHeader>
              <SettingForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {isError ? <ErrorNotice testId="status-locations-error" title="Could not load locations" message="Check your connection and try again." onRetry={() => void refetch()} /> : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2].map(i => (
            <Card key={i} className="h-64 bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : settings?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Map className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">No locations yet</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Create locations to maintain environmental consistency across shots.
          </p>
          <Button onClick={() => setIsCreateOpen(true)}>Create your first location</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {settings?.map(setting => (
            <Card key={setting.id} className="overflow-hidden group flex flex-col border-border/50 hover:border-primary/50 transition-colors bg-card/30 backdrop-blur-sm">
              <div className="aspect-[21/9] bg-secondary/30 relative flex items-center justify-center border-b border-border/50 overflow-hidden">
                {setting.thumbnail ? (
                  <img src={setting.thumbnail} alt={setting.name} loading="lazy" decoding="async" className="object-cover w-full h-full opacity-80 group-hover:opacity-100 transition-opacity" />
                ) : (
                  <ImageIcon className="size-10 text-muted-foreground/30" />
                )}
                <div className="absolute top-2 right-2 flex gap-1">
                  <Dialog open={editingId === setting.id} onOpenChange={(open) => setEditingId(open ? setting.id : null)}>
                    <DialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="secondary"
                        className="size-8 h-8 w-8 bg-background/90 backdrop-blur shadow-md"
                        aria-label={`Edit ${setting.name}`}
                        title={`Edit ${setting.name}`}
                      >
                        <Edit2 className="size-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-h-[100dvh] overflow-y-auto sm:max-w-[560px]">
                      <DialogHeader>
                        <DialogTitle>Edit Location</DialogTitle>
                      </DialogHeader>
                      <SettingForm
                        initialData={setting}
                        onSuccess={() => setEditingId(null)}
                      />
                    </DialogContent>
                  </Dialog>
                  <Button
                    size="icon"
                    variant="destructive"
                    className="size-8 h-8 w-8 shadow-md"
                    onClick={() => handleDelete(setting.id)}
                    aria-label={`Delete ${setting.name}`}
                    title={`Delete ${setting.name}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="p-4 flex-1 flex flex-col">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-semibold text-lg line-clamp-1">{setting.name}</h3>
                  <Badge variant="outline" className="bg-background/50">{setting.assetCount} assets</Badge>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">
                  {setting.description || "No description provided."}
                </p>
                {(setting.references?.length ?? 0) > 0 && <details className="mb-3 text-sm" data-testid={`details-references-${setting.id}`}>
                  <summary className="cursor-pointer">References and variants ({setting.references!.length})</summary>
                  <div className="mt-2"><LocationReferences settingId={setting.id} references={setting.references!} /></div>
                </details>}
                <div className="flex flex-wrap gap-1">
                  {setting.tags?.slice(0, 3).map(tag => (
                    <Badge key={tag} variant="secondary" className="text-xs px-2 py-0 h-5 bg-secondary/50">{tag}</Badge>
                  ))}
                  {(setting.tags?.length || 0) > 3 && (
                    <Badge variant="secondary" className="text-xs px-2 py-0 h-5 bg-secondary/50">+{setting.tags!.length - 3}</Badge>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}

function SettingForm({ initialData, onSuccess }: { initialData?: Setting, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createMutation = useCreateSetting();
  const updateMutation = useUpdateSetting();
  const { toast } = useToast();

  const [activeId, setActiveId] = useState<string | undefined>(initialData?.id);
  const [name, setName] = useState(initialData?.name ?? "");
  const [prompt, setPrompt] = useState(initialData?.promptDescription || initialData?.description || "");
  const [tags, setTags] = useState(initialData?.tags?.join(", ") ?? "");
  // A summary the user wrote separately is preserved (and editable under More options); otherwise derived.
  const [summary, setSummary] = useState<string | null>(
    hasDistinctShortDescription(initialData?.description, initialData?.promptDescription) ? initialData!.description : null,
  );
  const [thumbnail, setThumbnail] = useState<string>(initialData?.thumbnail || "");
  const [source, setSource] = useState<"generate" | "upload">("generate");
  const [uploads, setUploads] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const savePromise = useRef<Promise<string> | null>(null);
  const idRef = useRef<string | undefined>(initialData?.id);

  // Live references from the shared list cache so newly generated images are editable immediately.
  const { data: settings } = useListSettings({ query: { queryKey: getListSettingsQueryKey() } });
  const live = settings?.find((s) => s.id === activeId);
  const references = live?.references ?? initialData?.references ?? [];

  const buildData = (thumb: string) => ({
    name: name.trim(),
    description: resolveShortDescription(prompt, summary),
    promptDescription: prompt.trim(),
    // Omit an unset thumbnail on updates: a durable job may have supplied one
    // since this dialog opened. Never clear that image with stale form state.
    ...locationThumbnailInput(thumb),
    tags: parseTags(tags),
  });

  // Serialised save: concurrent callers share one request, and the created ID is reused afterwards.
  const saveOrUpdate = (thumb = thumbnail): Promise<string> => {
    if (savePromise.current) return savePromise.current;
    const run = (async () => {
      const data = buildData(thumb);
      if (idRef.current) {
        await updateMutation.mutateAsync({ id: idRef.current, data });
      } else {
        const saved = await createMutation.mutateAsync({ data });
        idRef.current = saved.id;
        setActiveId(saved.id);
      }
      return idRef.current!;
    })();
    savePromise.current = run;
    return run.finally(() => { savePromise.current = null; });
  };

  const validate = () => {
    if (!name.trim()) throw new Error("Give the location a name first.");
    if (!prompt.trim()) throw new Error("Describe the location first.");
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      validate();
      const savedId = await saveOrUpdate();
      let finalThumbnail = live?.thumbnail || thumbnail;
      if (source === "upload" || uploads.length) {
        for (const file of uploads) {
          const response = await fetch(`/api/settings/${savedId}/assets`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": file.type, "x-file-name": file.name },
            body: file,
          });
          const result = await response.json().catch(() => ({})) as { mediaUrl?: string; error?: string };
          if (!response.ok) throw new Error(result.error ?? "Image upload failed");
          finalThumbnail ||= result.mediaUrl ?? "";
          setThumbnail(finalThumbnail);
          // If a later file fails, retry only the files still waiting.
          setUploads(pending => pending.filter(candidate => candidate !== file));
        }
        setUploads([]);
      }
      if (finalThumbnail && finalThumbnail !== thumbnail) {
        setThumbnail(finalThumbnail);
        await saveOrUpdate(finalThumbnail);
      }
      await queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
      onSuccess();
    } catch (err) {
      void queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
      toast({ title: "Error saving location", description: err instanceof Error ? err.message : "Try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Generation is queued against a saved location, so save the current form first.
  const ensureSaved = async () => {
    validate();
    const id = await saveOrUpdate();
    await queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
    return id;
  };

  const isPending = saving || createMutation.isPending || updateMutation.isPending;
  const derived = deriveShortDescription(prompt);

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate={false}>
      <div className="space-y-2">
        <Label htmlFor="location-name">Name</Label>
        <Input id="location-name" required disabled={isPending} value={name} onChange={(e) => setName(e.target.value)} className="bg-secondary/20" data-testid="input-location-name" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="location-prompt">Description</Label>
        <Textarea
          id="location-prompt"
          required
          disabled={isPending}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-28 bg-secondary/20"
          placeholder="Architecture, lighting, mood, colors and details that should stay consistent across scenes."
          aria-describedby="location-prompt-hint"
          data-testid="input-location-prompt"
        />
        <p id="location-prompt-hint" className="text-xs text-muted-foreground">Used as the image prompt and to keep this environment consistent in generated scenes.</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Image</legend>
        <div className="grid grid-cols-2 gap-1 rounded-md bg-secondary/40 p-1 text-xs" role="radiogroup" aria-label="Image source">
          {([["generate", "Generate image", Sparkles], ["upload", "Upload image", Upload]] as const).map(([v, label, Icon]) => (
            <label key={v}
              className={`relative flex cursor-pointer items-center justify-center gap-1.5 rounded px-2 py-2 font-medium transition-colors focus-within:ring-2 focus-within:ring-ring ${source === v ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
              <input type="radio" name="location-image-source" value={v} checked={source === v} disabled={isPending}
                onChange={() => setSource(v)} className="sr-only" data-testid={`radio-location-source-${v}`} />
              <Icon className="size-3.5" aria-hidden />{label}
            </label>
          ))}
        </div>
        <div hidden={source !== "generate"}>
          <LocationImageJob mode="base" ensureSaved={ensureSaved} basePrompt={prompt} references={references} disabled={isPending} />
        </div>
        {source === "upload" && (
          <div className="space-y-2">
            <FileDropzone compact multiple disabled={isPending} accept="image/jpeg,image/png,image/webp" title={uploads.length ? `${uploads.length} image${uploads.length === 1 ? "" : "s"} selected` : "Choose or drop images"} hint="JPG, PNG or WebP" onFiles={setUploads} testId="dropzone-location-references" />
            <p className="text-xs text-muted-foreground">No AI generation. Images upload when you save; the first becomes the thumbnail if none is set.</p>
          </div>
        )}
      </fieldset>

      <details className="group rounded-lg border border-border/60 bg-secondary/10" data-testid="details-location-more">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          More options
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-4 border-t border-border/60 p-3">
          <div className="space-y-2">
            <Label htmlFor="location-tags">Tags <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="location-tags" disabled={isPending} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="interior, studio, nighttime" className="bg-secondary/20" data-testid="input-location-tags" />
          </div>
          {summary !== null ? (
            <div className="space-y-2">
              <Label htmlFor="location-summary">Card summary</Label>
              <Input id="location-summary" maxLength={SHORT_DESCRIPTION_MAX} value={summary} onChange={(e) => setSummary(e.target.value)} className="bg-secondary/20" data-testid="input-location-summary" />
              <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setSummary(null)} data-testid="button-summary-derive">Use description instead</button>
            </div>
          ) : derived ? (
            <p className="text-xs text-muted-foreground" data-testid="text-location-summary-derived">Card summary: {derived}</p>
          ) : null}
          {source === "generate" && (
            <div className="space-y-2">
              <Label>Also upload images</Label>
              <FileDropzone compact multiple disabled={isPending} accept="image/jpeg,image/png,image/webp" title={uploads.length ? `${uploads.length} image${uploads.length === 1 ? "" : "s"} selected` : "Choose or drop images"} hint="Uploaded when you save" onFiles={setUploads} testId="dropzone-location-references-extra" />
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">Variants &amp; image editing</p>
            <LocationImageJob mode="variant" ensureSaved={ensureSaved} references={references} disabled={isPending} />
          </div>
          {activeId && references.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Images ({references.length})</p>
              <LocationReferences settingId={activeId} references={references} />
            </div>
          )}
        </div>
      </details>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isPending} data-testid="button-save-location">
          {isPending ? "Saving..." : "Save location"}
        </Button>
      </div>
    </form>
  );
}
