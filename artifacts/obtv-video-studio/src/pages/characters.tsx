import { useState, useRef } from "react";
import { useListCharacters, useDeleteCharacter, useCreateCharacter, useUpdateCharacter } from "@workspace/api-client-react";
import { getListCharactersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Edit2, Trash2, Image as ImageIcon, Mic2, Users } from "lucide-react";
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

export default function CharactersPage() {
  const { data: characters, isLoading } = useListCharacters();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteCharacter();

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this character?")) {
      await deleteMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    }
  };

  return (
    <Page>
      <PageHeader
        title="Characters"
        description="Manage reusable characters for your productions."
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="size-4" />
                New Character
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create Character</DialogTitle>
              </DialogHeader>
              <CharacterForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-64 bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : characters?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Users className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">No characters yet</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Create characters to reuse their visual consistency and prompt instructions across different generations.
          </p>
          <Button onClick={() => setIsCreateOpen(true)}>Create your first character</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {characters?.map(char => (
            <Card key={char.id} className="overflow-hidden group flex flex-col border-border/50 hover:border-primary/50 transition-colors bg-card/30 backdrop-blur-sm">
              <div className="aspect-video bg-secondary/30 relative flex items-center justify-center border-b border-border/50 overflow-hidden">
                {char.thumbnail ? (
                  <img src={char.thumbnail} alt={char.name} loading="lazy" decoding="async" className="object-cover w-full h-full opacity-80 group-hover:opacity-100 transition-opacity" />
                ) : (
                  <ImageIcon className="size-10 text-muted-foreground/30" />
                )}
                <div className="absolute top-2 right-2 flex gap-1">
                  <Dialog open={editingId === char.id} onOpenChange={(open) => setEditingId(open ? char.id : null)}>
                    <DialogTrigger asChild>
                      <Button
                        size="icon"
                        variant="secondary"
                        className="size-8 h-8 w-8 bg-background/90 backdrop-blur shadow-md"
                        aria-label={`Edit ${char.name}`}
                        title={`Edit ${char.name}`}
                      >
                        <Edit2 className="size-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[500px]">
                      <DialogHeader>
                        <DialogTitle>Edit Character</DialogTitle>
                      </DialogHeader>
                      <CharacterForm
                        initialData={char}
                        onSuccess={() => setEditingId(null)}
                      />
                    </DialogContent>
                  </Dialog>
                  <Button
                    size="icon"
                    variant="destructive"
                    className="size-8 h-8 w-8 shadow-md"
                    onClick={() => handleDelete(char.id)}
                    aria-label={`Delete ${char.name}`}
                    title={`Delete ${char.name}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="p-4 flex-1 flex flex-col">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-semibold text-lg line-clamp-1">{char.name}</h3>
                  <div className="flex gap-1">
                    {char.hasVoiceSample && <Badge variant="secondary" className="gap-1"><Mic2 className="size-3" />Voice ready</Badge>}
                    <Badge variant="outline" className="bg-background/50">{char.assetCount} assets</Badge>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">
                  {char.description || "No description provided."}
                </p>
                <div className="flex flex-wrap gap-1">
                  {char.tags?.slice(0, 3).map(tag => (
                    <Badge key={tag} variant="secondary" className="text-xs px-2 py-0 h-5 bg-secondary/50">{tag}</Badge>
                  ))}
                  {(char.tags?.length || 0) > 3 && (
                    <Badge variant="secondary" className="text-xs px-2 py-0 h-5 bg-secondary/50">+{char.tags!.length - 3}</Badge>
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

function CharacterForm({ initialData, onSuccess }: { initialData?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createMutation = useCreateCharacter();
  const updateMutation = useUpdateCharacter();

  const formRef = useRef<HTMLFormElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(initialData?.id);
  const [thumbnail, setThumbnail] = useState<string>(initialData?.thumbnail || "");
  const [voiceSampleUrl, setVoiceSampleUrl] = useState<string>(initialData?.voiceSampleUrl || "");
  const [voicePending, setVoicePending] = useState(false);
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
      voiceProfile: (formData.get("voiceProfile") as string) || null,
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
      const voiceFile = formData.get("voiceSample");

      let finalThumbnail = thumbnail;
      for (const file of files) {
        const response = await fetch(`/api/characters/${savedId}/assets`, {
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

      if (voiceFile instanceof File && voiceFile.size > 0) {
        if (formData.get("voiceConsent") !== "confirmed") {
          throw new Error("Confirm that you have permission to clone this voice.");
        }
        setVoicePending(true);
        try {
          const response = await fetch(`/api/characters/${savedId}/voice-sample`, {
            method: "POST",
            headers: {
              "content-type": voiceFile.type || "audio/wav",
              "x-file-name": encodeURIComponent(voiceFile.name),
              "x-voice-consent": "confirmed",
            },
            body: voiceFile,
          });
          const result = await response.json() as { voiceSampleUrl?: string; error?: string };
          if (!response.ok) throw new Error(result.error ?? "Voice sample upload failed");
          setVoiceSampleUrl(result.voiceSampleUrl ?? "");
        } finally {
          setVoicePending(false);
        }
      }

      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Error saving character", description: err.message, variant: "destructive" });
    }
  };

  const handleGenerateImage = async (prompt: string, seed?: number) => {
    if (!formRef.current?.checkValidity()) {
      formRef.current?.reportValidity();
      throw new Error("Please fill out required fields first to save the character.");
    }

    // Save first
    const { id, data } = await saveOrUpdate();

    // Generate
    const res = await fetch(`/api/characters/${id}/generate-image`, {
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

    queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });

    return result.mediaUrl;
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const removeVoiceSample = async () => {
    if (!activeId) return;
    setVoicePending(true);
    try {
      const response = await fetch(`/api/characters/${activeId}/voice-sample`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove the voice sample");
      setVoiceSampleUrl("");
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    } catch (err: any) {
      toast({ title: "Error removing voice", description: err.message, variant: "destructive" });
    } finally {
      setVoicePending(false);
    }
  };

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
          <Label htmlFor="promptDescription">Character appearance</Label>
          <Textarea
            id="promptDescription"
            name="promptDescription"
            required
            defaultValue={initialData?.promptDescription}
            className="min-h-24 bg-secondary/20"
            placeholder="Describe facial features, hair, clothing, build, age, and other details that should remain consistent."
          />
          <p className="text-xs text-muted-foreground">Used to keep this character consistent across generated scenes.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tags">Tags <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="tags" name="tags" defaultValue={initialData?.tags?.join(", ")} placeholder="host, expert, recurring" className="bg-secondary/20" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="referenceImages">Reference images</Label>
          <Input id="referenceImages" name="referenceImages" type="file" accept="image/jpeg,image/png,image/webp" multiple className="bg-secondary/20" />
          <p className="text-xs text-muted-foreground">Upload approved JPG, PNG, or WebP images. The first image becomes the thumbnail automatically.</p>
        </div>

        <div className="space-y-3 rounded-lg border border-border/60 bg-secondary/10 p-4">
          <div>
            <Label htmlFor="voiceSample">Character voice <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload 5–20 seconds of one person speaking clearly, with no music, echo, or other voices.
            </p>
          </div>
          {voiceSampleUrl && (
            <div className="flex items-center gap-3">
              <audio controls preload="metadata" src={voiceSampleUrl} className="h-9 min-w-0 flex-1" />
              <Button type="button" variant="outline" size="sm" disabled={voicePending} onClick={removeVoiceSample}>
                Remove
              </Button>
            </div>
          )}
          <Input
            id="voiceSample"
            name="voiceSample"
            type="file"
            accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg"
            className="bg-secondary/20"
          />
          <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <input name="voiceConsent" value="confirmed" type="checkbox" className="mt-1 size-4" />
            <span>I confirm I own this voice or have the speaker’s permission to create and use a cloned voice.</span>
          </label>
          <div className="space-y-2">
            <Label htmlFor="voiceProfile">Voice direction <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input
              id="voiceProfile"
              name="voiceProfile"
              defaultValue={initialData?.voiceProfile || ""}
              placeholder="Warm, calm delivery with measured pacing"
              className="bg-secondary/20"
            />
          </div>
          {voiceSampleUrl && <p className="text-xs font-medium text-emerald-500">Voice ready for exact dialogue.</p>}
        </div>

        <div className="pt-2">
          <ImageGenerator
            onGenerate={handleGenerateImage}
            defaultPrompt={initialData?.promptDescription || ""}
          />
        </div>

        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending || voicePending}>
            {isPending || voicePending ? "Saving..." : activeId ? "Save Changes" : "Create Character"}
          </Button>
        </div>
      </form>
    </div>
  );
}
