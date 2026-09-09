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
import { ImageGenerator } from "@/components/studio/ImageGenerator";

export default function SettingsPage() {
  const { data: settings, isLoading } = useListSettings();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteSetting();

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this setting?")) {
      await deleteMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
    }
  };

  return (
    <Page>
      <PageHeader
        title="Settings & Environments"
        description="Manage reusable locations and environments for your scenes."
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="size-4" />
                New Setting
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create Setting</DialogTitle>
              </DialogHeader>
              <SettingForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {isLoading ? (
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
          <h3 className="text-xl font-semibold mb-2">No settings yet</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Create locations to maintain environmental consistency across shots.
          </p>
          <Button onClick={() => setIsCreateOpen(true)}>Create your first setting</Button>
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
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Dialog open={editingId === setting.id} onOpenChange={(open) => setEditingId(open ? setting.id : null)}>
                    <DialogTrigger asChild>
                      <Button size="icon" variant="secondary" className="size-8 h-8 w-8 bg-background/80 backdrop-blur">
                        <Edit2 className="size-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[500px]">
                      <DialogHeader>
                        <DialogTitle>Edit Setting</DialogTitle>
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
                    className="size-8 h-8 w-8"
                    onClick={() => handleDelete(setting.id)}
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

      const formData = new FormData(e.currentTarget);
      const files = formData.getAll("referenceImages").filter((entry): entry is File => entry instanceof File && entry.size > 0);

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
      toast({ title: "Error saving setting", description: err.message, variant: "destructive" });
    }
  };

  const handleGenerateImage = async (prompt: string, seed?: number) => {
    if (!formRef.current?.checkValidity()) {
      formRef.current?.reportValidity();
      throw new Error("Please fill out required fields first to save the setting.");
    }

    // Save first
    const { id, data } = await saveOrUpdate();

    // Generate
    const res = await fetch(`/api/settings/${id}/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, seed })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed to generate image");

    // Update thumbnail if empty
    if (!thumbnail) {
      setThumbnail(result.mediaUrl);
      await updateMutation.mutateAsync({ id, data: { ...data, thumbnail: result.mediaUrl } });
    }

    queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });

    return result.mediaUrl;
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
          <Label htmlFor="referenceImages">Reference images</Label>
          <Input id="referenceImages" name="referenceImages" type="file" accept="image/jpeg,image/png,image/webp" multiple className="bg-secondary/20" />
          <p className="text-xs text-muted-foreground">Upload approved JPG, PNG, or WebP images. The first image becomes the thumbnail automatically.</p>
        </div>

        <div className="pt-2">
          <ImageGenerator
            onGenerate={handleGenerateImage}
            defaultPrompt={initialData?.promptDescription || ""}
          />
        </div>

        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : activeId ? "Save Changes" : "Create Setting"}
          </Button>
        </div>
      </form>
    </div>
  );
}
