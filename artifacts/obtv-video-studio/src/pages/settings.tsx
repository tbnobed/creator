import { FileDropzone } from "@/components/shared/file-dropzone";
import { useState, useRef } from "react";
import { useListSettings, useDeleteSetting, useCreateSetting, useUpdateSetting } from "@workspace/api-client-react";
import { getListSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Edit2, Trash2, Map, Image as ImageIcon } from "lucide-react";
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

function SettingForm({ initialData, onSuccess }: { initialData?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createMutation = useCreateSetting();
  const updateMutation = useUpdateSetting();

  const formRef = useRef<HTMLFormElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(initialData?.id);
  const [thumbnail, setThumbnail] = useState<string>(initialData?.thumbnail || "");
  const [uploads, setUploads] = useState<File[]>([]);
  const { toast } = useToast();

  const getFormData = () => {
    if (!formRef.current) return null;
    const formData = new FormData(formRef.current);

    const tagsStr = formData.get("tags") as string;
    const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(Boolean) : [];

    return {
      name: formData.get("name") as string,
      description: formData.get("description") as string,
      promptDescription: formData.get("promptDescription") as string,
      thumbnail: thumbnail || null,
      tags,
    };
  };

  const saveOrUpdate = async () => {
    const data = getFormData();
    if (!data) throw new Error("Could not get form data");

    let currentId = activeId;
    let saved;
    if (currentId) {
      saved = await updateMutation.mutateAsync({ id: currentId, data });
    } else {
      saved = await createMutation.mutateAsync({ data });
      setActiveId(saved.id);
      currentId = saved.id;
    }
    return { id: currentId, data };
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const { id: savedId, data } = await saveOrUpdate();

      const files = uploads;

      let finalThumbnail = thumbnail;
      for (const file of files) {
        const response = await fetch(`/api/settings/${savedId}/assets`, {
          method: "POST",
          headers: { "content-type": file.type, "x-file-name": file.name },
          body: file,
        });
        const result = await response.json() as { mediaUrl?: string; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Reference image upload failed");
        finalThumbnail ||= result.mediaUrl ?? "";
      }
      if (finalThumbnail !== (data.thumbnail || "") && finalThumbnail !== "") {
        setThumbnail(finalThumbnail);
        await updateMutation.mutateAsync({ id: savedId, data: { ...data, thumbnail: finalThumbnail } });
      }

      queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Error saving location", description: err.message, variant: "destructive" });
    }
  };

  // Generation is queued against a saved location, so save the form first.
  const ensureSaved = async () => {
    if (!formRef.current?.checkValidity()) {
      formRef.current?.reportValidity();
      throw new Error("Fill out the required fields first so the location can be saved.");
    }
    const { id } = await saveOrUpdate();
    queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
    return id;
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required defaultValue={initialData?.name} className="bg-secondary/20" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Short Description</Label>
          <Input id="description" name="description" required defaultValue={initialData?.description} className="bg-secondary/20" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="promptDescription">Environment appearance</Label>
          <Textarea
            id="promptDescription"
            name="promptDescription"
            required
            defaultValue={initialData?.promptDescription}
            className="min-h-24 bg-secondary/20"
            placeholder="Describe the location, architecture, lighting, mood, colors, and details that should remain consistent."
          />
          <p className="text-xs text-muted-foreground">Used to keep this environment consistent across generated scenes.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tags">Tags <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="tags" name="tags" defaultValue={initialData?.tags?.join(", ")} placeholder="interior, studio, nighttime" className="bg-secondary/20" />
        </div>
        <div className="space-y-2">
          <Label>Reference images</Label>
          <FileDropzone compact multiple accept="image/jpeg,image/png,image/webp" title={uploads.length ? `${uploads.length} image${uploads.length === 1 ? "" : "s"} selected` : "Choose or drop reference images"} hint="JPG, PNG or WebP" onFiles={setUploads} testId="dropzone-location-references" />
          <p className="text-xs text-muted-foreground">Upload approved JPG, PNG, or WebP images. The first image becomes the thumbnail automatically.</p>
        </div>

        <div className="pt-2">
          <LocationImageJob
            ensureSaved={ensureSaved}
            defaultPrompt={initialData?.promptDescription || ""}
            references={initialData?.references ?? []}
          />
        </div>

        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending} data-testid="button-save-location">
            {isPending ? "Saving..." : activeId ? "Save Changes" : "Create Location"}
          </Button>
        </div>
      </form>
    </div>
  );
}
