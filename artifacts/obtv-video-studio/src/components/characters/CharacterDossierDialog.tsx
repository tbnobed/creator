import { useState, useRef, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mic2, Save, CheckCircle2, Camera, Shirt, Fingerprint } from "lucide-react";
import { 
  useCreateCharacter, 
  useUpdateCharacter, 
  useListCharacters, 
  getListCharactersQueryKey,
  Character,
  useGetCharacterDossier, 
  useUpdateCharacterDossier, 
  useApproveCharacterDossier,
  getGetCharacterDossierQueryKey,
  CharacterWardrobe as IWardrobe
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DossierReferences } from "./DossierReferences";
import { DossierWardrobe } from "./DossierWardrobe";
import { DossierVoice } from "./DossierVoice";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { useForm } from "react-hook-form";

export function CharacterDossierDialog({
  characterId,
  open,
  onOpenChange,
}: {
  characterId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: characters } = useListCharacters();
  const character = characters?.find(c => c.id === characterId);
  
  const isNew = open && !characterId;
  const [isDirty, setIsDirty] = useState(false);
  
  const handleOpenChange = (val: boolean) => {
    if (!val) {
      if (isDirty) {
        if (!confirm("You have unsaved changes in this dossier. Are you sure you want to discard them?")) {
          return;
        }
      }
      onOpenChange(false);
    } else {
      onOpenChange(val);
    }
  };
  
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open && (
        <CharacterDossierEditor 
          character={character} 
          isNew={isNew} 
          onClose={() => onOpenChange(false)} 
          onDirtyChange={setIsDirty}
        />
      )}
    </Dialog>
  );
}

function CharacterDossierEditor({ 
  character, 
  isNew, 
  onClose,
  onDirtyChange
}: { 
  character?: Character, 
  isNew: boolean, 
  onClose: () => void,
  onDirtyChange: (dirty: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState("identity");
  const [activeId, setActiveId] = useState<string | undefined>(character?.id);
  
  const { data: dossier, isLoading: isDossierLoading } = useGetCharacterDossier(activeId || "", { 
    query: {
      enabled: !!activeId,
      queryKey: getGetCharacterDossierQueryKey(activeId || ""),
      refetchOnMount: "always",
      refetchInterval: (query) => {
        const status = query.state.data?.imageGeneration?.status;
        return status === "QUEUED" || status === "RUNNING" ? 2000 : false;
      },
    } 
  });
  const updateDossierMutation = useUpdateCharacterDossier();
  const approveDossierMutation = useApproveCharacterDossier();
  
  const createMutation = useCreateCharacter();
  const updateMutation = useUpdateCharacter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      name: character?.name || "",
      description: character?.description || "",
      promptDescription: character?.promptDescription || "",
      tags: character?.tags?.join(", ") || "",
      role: "",
      performanceNotes: "",
      wardrobes: [] as IWardrobe[],
    }
  });

  const isFormDirty = form.formState.isDirty;
  useEffect(() => {
    onDirtyChange(isFormDirty);
  }, [isFormDirty, onDirtyChange]);

  const initializedForId = useRef<string | null>(null);
  useEffect(() => {
    if (dossier && activeId && initializedForId.current !== activeId) {
      initializedForId.current = activeId;
      const currentValues = form.getValues();
      form.reset({
        ...currentValues,
        role: dossier.role || "",
        performanceNotes: dossier.performanceNotes || "",
        wardrobes: dossier.wardrobes || [],
      });
    }
  }, [dossier, activeId, form]);

  const saveBaseCharacter = async () => {
    const values = form.getValues();
    const baseData = {
      name: values.name,
      description: values.description,
      promptDescription: values.promptDescription,
      tags: values.tags ? values.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
    };
    
    if (!activeId) {
      const saved = await createMutation.mutateAsync({ data: baseData });
      initializedForId.current = saved.id;
      setActiveId(saved.id);
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      return saved;
    } else {
      const saved = await updateMutation.mutateAsync({ 
        id: activeId, 
        data: { ...baseData, expectedDossierRevision: dossier?.revision ?? 0 } 
      });
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      return saved;
    }
  };

  const handleSaveDraft = async () => {
    try {
      const savedChar = await saveBaseCharacter();
      const id = savedChar.id;
      
      const values = form.getValues();
      const updatedDossier = await updateDossierMutation.mutateAsync({
        id,
        data: {
          role: values.role,
          performanceNotes: values.performanceNotes,
          wardrobes: values.wardrobes,
          revision: savedChar.dossierRevision,
        }
      });
      
      form.reset({
        ...form.getValues(),
        role: updatedDossier.role || "",
        performanceNotes: updatedDossier.performanceNotes || "",
        wardrobes: updatedDossier.wardrobes || [],
      });
      
      toast({ title: "Draft saved successfully" });
    } catch (err: any) {
      const isConflict = err.message?.includes("409") || err.status === 409 || err.message?.toLowerCase().includes("conflict");
      if (isConflict) {
        toast({ title: "Conflict detected", description: "Another user updated this dossier. Please reload.", variant: "destructive" });
      } else {
        toast({ title: "Error saving draft", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleApprove = async () => {
    try {
      const savedChar = await saveBaseCharacter();
      const id = savedChar.id;
      
      const values = form.getValues();
      const updatedDossier = await updateDossierMutation.mutateAsync({
        id,
        data: {
          role: values.role,
          performanceNotes: values.performanceNotes,
          wardrobes: values.wardrobes,
          revision: savedChar.dossierRevision,
        }
      });
      
      await approveDossierMutation.mutateAsync({
        id,
        data: { revision: updatedDossier.revision }
      });
      
      toast({ title: "Dossier Approved", description: "Character is ready for production use." });
      
      form.reset(values);
      onClose();
    } catch (err: any) {
      const isConflict = err.message?.includes("409") || err.status === 409 || err.message?.toLowerCase().includes("conflict");
      if (isConflict) {
        toast({ title: "Conflict detected", description: "Another user updated this dossier. Please reload.", variant: "destructive" });
      } else {
        toast({ title: "Error approving dossier", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleCancelClick = () => {
    if (isFormDirty) {
      if (!confirm("You have unsaved changes in this dossier. Are you sure you want to discard them?")) {
        return;
      }
    }
    form.reset();
    onClose();
  };

  const handleInteractOutside = (e: Event) => {
    const target = e.target as HTMLElement | null;
    // The image viewer and its delete confirmation are intentionally portaled
    // outside this dossier dialog. Treat their interactions as inside the
    // dossier so opening/cancelling a confirmation cannot discard the form.
    if (target?.closest("[data-dossier-image-viewer], [data-radix-alert-dialog-content]")) {
      e.preventDefault();
      return;
    }
    if (isFormDirty) {
      e.preventDefault();
      handleCancelClick();
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending || updateDossierMutation.isPending || approveDossierMutation.isPending;

  return (
    <DialogContent 
      className="w-full max-w-[1400px] sm:w-[96vw] h-[100dvh] sm:h-[92dvh] sm:max-h-[960px] flex flex-col p-0 overflow-hidden bg-background border-border shadow-2xl"
      onInteractOutside={handleInteractOutside}
      onEscapeKeyDown={handleInteractOutside}
    >
      <DialogHeader className="px-4 sm:px-6 py-4 border-b border-border/50 shrink-0 bg-card/30 backdrop-blur-sm">
        <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
          <div className="pr-4 w-full">
            <DialogTitle className="text-xl font-bold tracking-tight mb-1 flex flex-wrap items-center gap-2">
              {activeId ? `Editing Dossier: ${form.watch("name") || "Unnamed"}` : "New Character Dossier"}
              {dossier?.status === "APPROVED" && (
                <Badge variant="default" className="bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/30">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Approved
                </Badge>
              )}
              {dossier?.status === "DRAFT" && (
                <Badge variant="outline" className="text-muted-foreground border-border/50">Draft</Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Prepare casting details, visual references, wardrobe, and voice.
            </DialogDescription>
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto shrink-0">
            <Button variant="outline" onClick={handleCancelClick} disabled={isPending}>Cancel</Button>
            <Button variant="secondary" onClick={handleSaveDraft} disabled={isPending} data-testid="button-save-draft">
              {isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Draft
            </Button>
            <Button onClick={handleApprove} disabled={isPending || !activeId} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="button-approve-dossier">
              Approve Dossier
            </Button>
          </div>
        </div>
      </DialogHeader>

      <div className="flex-1 flex overflow-hidden min-h-0 min-w-0">
        <Form {...form}>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-w-0">
            <div className="px-0 sm:px-6 border-b border-border/50 bg-muted/20 overflow-x-auto no-scrollbar">
              <TabsList className="bg-transparent border-none h-12 w-max min-w-full justify-start gap-2 sm:gap-6 rounded-none px-4 sm:px-0 flex-nowrap">
                <TabsTrigger 
                  value="identity" 
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-2 whitespace-nowrap shrink-0"
                >
                  <Fingerprint className="w-4 h-4 mr-2" />
                  Identity & Performance
                </TabsTrigger>
                <TabsTrigger 
                  value="references" 
                  disabled={!activeId}
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-2 whitespace-nowrap shrink-0"
                >
                  <Camera className="w-4 h-4 mr-2" />
                  Visual References
                </TabsTrigger>
                <TabsTrigger 
                  value="wardrobe" 
                  disabled={!activeId}
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-2 whitespace-nowrap shrink-0"
                >
                  <Shirt className="w-4 h-4 mr-2" />
                  Wardrobe
                </TabsTrigger>
                <TabsTrigger 
                  value="voice" 
                  disabled={!activeId}
                  className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-12 px-2 whitespace-nowrap shrink-0"
                >
                  <Mic2 className="w-4 h-4 mr-2" />
                  Voice Cloning
                </TabsTrigger>
              </TabsList>
            </div>
            
            <ScrollArea className="flex-1">
              <div className="p-4 sm:p-6 w-full min-w-0">
                <TabsContent value="identity" className="m-0 h-full">
                  <form className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div>
                          <h3 className="text-lg font-semibold mb-1">Core Identity</h3>
                          <p className="text-sm text-muted-foreground">The foundational traits that define this character.</p>
                        </div>
                        
                        <FormField
                          control={form.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Character Name</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="e.g. Detective Miller" className="bg-secondary/20" />
                              </FormControl>
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="description"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Short Description</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="e.g. Grizzled veteran detective" className="bg-secondary/20" />
                              </FormControl>
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="tags"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Tags (comma separated)</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="detective, protagonist, recurring" className="bg-secondary/20" />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="space-y-4">
                        <div>
                          <h3 className="text-lg font-semibold mb-1">Casting & Performance</h3>
                          <p className="text-sm text-muted-foreground">Directing notes for generating behavior and appearance.</p>
                        </div>
                        
                        <FormField
                          control={form.control}
                          name="role"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Role in Production</FormLabel>
                              <FormControl>
                                <Input {...field} placeholder="e.g. Lead Antagonist" className="bg-secondary/20" />
                              </FormControl>
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="promptDescription"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Appearance Prompt</FormLabel>
                              <FormControl>
                                <Textarea 
                                  {...field} 
                                  placeholder="Physical traits, facial structure, age, build, hair... This is sent to the image generator." 
                                  className="h-24 resize-none bg-secondary/20" 
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="performanceNotes"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Performance Notes</FormLabel>
                              <FormControl>
                                <Textarea 
                                  {...field} 
                                  placeholder="Mannerisms, common expressions, posture, energy level..." 
                                  className="h-24 resize-none bg-secondary/20" 
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  </form>
                </TabsContent>

                {activeId && (
                  <>
                    <TabsContent value="references" className="m-0 h-full">
                      <DossierReferences
                        characterId={activeId}
                        dossier={dossier}
                        characterThumbnail={character?.thumbnail}
                      />
                    </TabsContent>
                    
                    <TabsContent value="wardrobe" className="m-0 h-full">
                      <DossierWardrobe form={form} />
                    </TabsContent>
                    
                    <TabsContent value="voice" className="m-0 h-full">
                      <DossierVoice characterId={activeId} character={character} />
                    </TabsContent>
                  </>
                )}
              </div>
            </ScrollArea>
          </Tabs>
        </Form>
      </div>
    </DialogContent>
  );
}
