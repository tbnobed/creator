import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useFieldArray } from "react-hook-form";
import * as z from "zod";
import { Loader2, Plus, Trash2, Settings2, UserRound, MapPin } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssetPicker } from "./AssetPicker";
import { 
  getGetLongFormProjectQueryKey,
  useListCharacters,
  useUpdateLongFormContinuity
} from "@workspace/api-client-react";

const wardrobeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, "Name required"),
  description: z.string().min(1, "Description required"),
  referenceAssetId: z.string().optional(),
});

const characterContinuitySchema = z.object({
  characterId: z.string().min(1),
  appearance: z.string().default(""),
  behavior: z.string().default(""),
  voiceDescription: z.string().default(""),
  wardrobes: z.array(wardrobeSchema).default([]),
});

const wardrobeAssignmentSchema = z.object({
  characterId: z.string(),
  wardrobeId: z.string(),
});

const sceneContinuitySchema = z.object({
  sceneNumber: z.number(),
  title: z.string().default(""),
  settingNotes: z.string().default(""),
  emotionNotes: z.string().default(""),
  wardrobeAssignments: z.array(wardrobeAssignmentSchema).default([]),
});

const formSchema = z.object({
  enabled: z.boolean().default(false),
  characters: z.array(characterContinuitySchema).default([]),
  scenes: z.array(sceneContinuitySchema).default([]),
});

type FormValues = z.infer<typeof formSchema>;

export function ContinuityEditor({ project, open, onOpenChange }: { project: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: globalCharacters = [] } = useListCharacters();
  const updateContinuity = useUpdateLongFormContinuity();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      enabled: project.continuity?.enabled ?? false,
      characters: project.continuity?.characters ?? [],
      scenes: project.continuity?.scenes ?? [],
    },
  });

  const { fields: charFields, append: appendChar, remove: removeChar } = useFieldArray({
    control: form.control,
    name: "characters",
  });

  const { fields: sceneFields, append: appendScene } = useFieldArray({
    control: form.control,
    name: "scenes",
  });

  const initializeMissing = () => {
    const currentChars = form.getValues("characters");
    const currentScenes = form.getValues("scenes");

    project.characterIds?.forEach((cid: string) => {
      if (!currentChars.find((c) => c.characterId === cid)) {
        appendChar({ characterId: cid, appearance: "", behavior: "", voiceDescription: "", wardrobes: [] });
      }
    });

    const uniqueScenes = Array.from(new Set(project.shots?.map((s: any) => s.sceneNumber) || [])) as number[];
    uniqueScenes.forEach((sceneNum) => {
      if (!currentScenes.find((s) => s.sceneNumber === sceneNum)) {
        appendScene({ sceneNumber: sceneNum, title: `Scene ${sceneNum}`, settingNotes: "", emotionNotes: "", wardrobeAssignments: [] });
      }
    });
  };

  const getCharacterName = (id: string) => {
    return globalCharacters.find((c) => c.id === id)?.name || id;
  };

  const onSubmit = (values: FormValues) => {
    updateContinuity.mutate({ id: project.id, data: values }, {
      onSuccess: (updatedProject: any) => {
        queryClient.setQueryData(getGetLongFormProjectQueryKey(project.id), updatedProject);
        toast({ title: "Continuity settings updated" });
        onOpenChange(false);
      },
      onError: (err: any) => toast({ title: "Failed to update continuity", description: err.message, variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" /> Project Continuity
          </DialogTitle>
          <DialogDescription>
            Enforce consistent characters, wardrobes, and behavior across all generated shots.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-hidden flex flex-col">
              <ScrollArea className="flex-1 px-6 py-4">
                <div className="space-y-6">
                  <FormField
                    control={form.control}
                    name="enabled"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <div className="space-y-1 leading-none">
                          <FormLabel className="text-base font-semibold">Enable Continuity Checking</FormLabel>
                          <p className="text-sm text-muted-foreground mt-1.5">
                            When enabled, you must approve a generated still frame for each shot before it can be rendered into video.
                          </p>
                        </div>
                      </FormItem>
                    )}
                  />

                  {form.watch("enabled") && (
                    <Tabs defaultValue="characters" className="flex-1 flex flex-col h-full">
                      <TabsList className="grid w-full grid-cols-2 shrink-0">
                        <TabsTrigger value="characters"><UserRound className="w-4 h-4 mr-2" /> Characters & Wardrobes</TabsTrigger>
                        <TabsTrigger value="scenes"><MapPin className="w-4 h-4 mr-2" /> Scene Defaults</TabsTrigger>
                      </TabsList>
                      
                      <div className="mt-4 flex-1">
                        <TabsContent value="characters" className="mt-0 h-full">
                          <div className="flex justify-between items-center mb-4">
                            <h3 className="text-sm font-medium text-muted-foreground">Character Appearance & Behavior Locks</h3>
                            <Button type="button" variant="outline" size="sm" onClick={initializeMissing}>
                              Sync Project Cast
                            </Button>
                          </div>
                          
                          <div className="space-y-6">
                            {charFields.map((field, index) => (
                              <div key={field.id} className="p-4 rounded-xl border bg-card/50 space-y-4">
                                <div className="flex justify-between items-center pb-2 border-b">
                                  <h4 className="font-semibold text-primary">{getCharacterName(field.characterId)}</h4>
                                  <Button type="button" variant="ghost" size="icon" onClick={() => removeChar(index)}>
                                    <Trash2 className="w-4 h-4 text-destructive" />
                                  </Button>
                                </div>
                                
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <FormField
                                    control={form.control}
                                    name={`characters.${index}.appearance`}
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Base Appearance</FormLabel>
                                        <FormControl>
                                          <Textarea placeholder="Lock in physical traits, haircut..." className="resize-none h-20" {...field} />
                                        </FormControl>
                                      </FormItem>
                                    )}
                                  />
                                  <FormField
                                    control={form.control}
                                    name={`characters.${index}.behavior`}
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Behavior / Mannerisms</FormLabel>
                                        <FormControl>
                                          <Textarea placeholder="How they move, facial expressions..." className="resize-none h-20" {...field} />
                                        </FormControl>
                                      </FormItem>
                                    )}
                                  />
                                  <FormField
                                    control={form.control}
                                    name={`characters.${index}.voiceDescription`}
                                    render={({ field }) => (
                                      <FormItem className="md:col-span-2">
                                        <FormLabel>Voice Description / Tone</FormLabel>
                                        <FormControl>
                                          <Input placeholder="Deep, raspy, whispers..." {...field} />
                                        </FormControl>
                                      </FormItem>
                                    )}
                                  />
                                </div>

                                <div className="mt-4 p-3 bg-black/20 rounded-lg border border-border/50">
                                  <div className="flex items-center justify-between mb-3">
                                    <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wardrobe Presets</h5>
                                    <Button type="button" variant="secondary" size="sm" onClick={() => {
                                      const w = form.getValues(`characters.${index}.wardrobes`);
                                      form.setValue(`characters.${index}.wardrobes`, [...w, { id: crypto.randomUUID(), name: "New Outfit", description: "" }]);
                                    }}>
                                      <Plus className="w-3 h-3 mr-1" /> Add
                                    </Button>
                                  </div>
                                  
                                  <div className="space-y-3">
                                    {form.watch(`characters.${index}.wardrobes`).map((_, wIndex) => (
                                      <div key={wIndex} className="flex items-start gap-2">
                                        <div className="flex-1 space-y-2">
                                          <div className="flex gap-2">
                                            <FormField
                                              control={form.control}
                                              name={`characters.${index}.wardrobes.${wIndex}.name`}
                                              render={({ field }) => <Input className="w-1/3" placeholder="e.g. Heist Suit" {...field} />}
                                            />
                                            <FormField
                                              control={form.control}
                                              name={`characters.${index}.wardrobes.${wIndex}.description`}
                                              render={({ field }) => <Input className="flex-1" placeholder="Description..." {...field} />}
                                            />
                                          </div>
                                          <FormField
                                            control={form.control}
                                            name={`characters.${index}.wardrobes.${wIndex}.referenceAssetId`}
                                            render={({ field }) => (
                                              <AssetPicker
                                                value={field.value || undefined}
                                                onChange={(val) => field.onChange(val)}
                                                triggerClassName="w-full text-xs h-8"
                                                placeholder="Optional Image Studio Asset Reference..."
                                              />
                                            )}
                                          />
                                        </div>
                                        <Button type="button" variant="ghost" size="icon" onClick={() => {
                                          const w = [...form.getValues(`characters.${index}.wardrobes`)];
                                          const deletedWardrobeId = w[wIndex]?.id;
                                          w.splice(wIndex, 1);
                                          form.setValue(`characters.${index}.wardrobes`, w);
                                          
                                          // Also remove assignments in scenes that point to this wardrobe
                                          if (deletedWardrobeId) {
                                            const scenes = form.getValues("scenes");
                                            let scenesChanged = false;
                                            const newScenes = scenes.map(scene => {
                                              const assignments = scene.wardrobeAssignments || [];
                                              const filtered = assignments.filter(a => a.wardrobeId !== deletedWardrobeId);
                                              if (filtered.length !== assignments.length) {
                                                scenesChanged = true;
                                                return { ...scene, wardrobeAssignments: filtered };
                                              }
                                              return scene;
                                            });
                                            if (scenesChanged) {
                                              form.setValue("scenes", newScenes);
                                            }
                                          }
                                        }}>
                                          <Trash2 className="w-4 h-4" />
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </TabsContent>

                        <TabsContent value="scenes" className="mt-0 h-full">
                          <div className="flex justify-between items-center mb-4">
                            <h3 className="text-sm font-medium text-muted-foreground">Scene Context & Wardrobe Assignments</h3>
                            <Button type="button" variant="outline" size="sm" onClick={initializeMissing}>
                              Sync Scenes
                            </Button>
                          </div>
                          
                          <div className="space-y-4">
                            {sceneFields.map((field, index) => (
                              <div key={field.id} className="p-4 rounded-xl border bg-card/50 space-y-4">
                                <h4 className="font-semibold text-primary pb-2 border-b">Scene {field.sceneNumber}</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  <FormField
                                    control={form.control}
                                    name={`scenes.${index}.settingNotes`}
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Setting / Environment Notes</FormLabel>
                                        <FormControl>
                                          <Textarea placeholder="Lighting, time of day..." className="resize-none h-20" {...field} />
                                        </FormControl>
                                      </FormItem>
                                    )}
                                  />
                                  <FormField
                                    control={form.control}
                                    name={`scenes.${index}.emotionNotes`}
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Default Emotion</FormLabel>
                                        <FormControl>
                                          <Textarea placeholder="Tense, joyful..." className="resize-none h-20" {...field} />
                                        </FormControl>
                                      </FormItem>
                                    )}
                                  />
                                </div>
                                <div className="pt-2 border-t mt-4">
                                  <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Wardrobe Assignments</h5>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {form.watch("characters").map(char => {
                                      const charWardrobes = char.wardrobes || [];
                                      if (charWardrobes.length === 0) return null;
                                      
                                      const assignmentFieldPath = `scenes.${index}.wardrobeAssignments` as const;
                                      
                                      return (
                                        <FormField
                                          key={char.characterId}
                                          control={form.control}
                                          name={assignmentFieldPath}
                                          render={({ field }) => {
                                            const valArray = field.value || [];
                                            const assignment = valArray.find((a: any) => a.characterId === char.characterId);
                                            
                                            return (
                                              <FormItem className="flex items-center gap-3 space-y-0">
                                                <FormLabel className="w-1/3 truncate" title={getCharacterName(char.characterId)}>
                                                  {getCharacterName(char.characterId)}
                                                </FormLabel>
                                                <div className="flex-1">
                                                  <Select 
                                                    value={assignment?.wardrobeId || "none"}
                                                    onValueChange={(val) => {
                                                      const newArr = valArray.filter((a: any) => a.characterId !== char.characterId);
                                                      if (val !== "none") {
                                                        newArr.push({ characterId: char.characterId, wardrobeId: val });
                                                      }
                                                      field.onChange(newArr);
                                                    }}
                                                  >
                                                    <FormControl>
                                                      <SelectTrigger className="h-8 text-xs">
                                                        <SelectValue placeholder="Default" />
                                                      </SelectTrigger>
                                                    </FormControl>
                                                    <SelectContent>
                                                      <SelectItem value="none">Unassigned / Default</SelectItem>
                                                      {charWardrobes.map(w => (
                                                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                                                      ))}
                                                    </SelectContent>
                                                  </Select>
                                                </div>
                                              </FormItem>
                                            );
                                          }}
                                        />
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </TabsContent>
                      </div>
                    </Tabs>
                  )}
                </div>
              </ScrollArea>
            </div>
            
            <DialogFooter className="p-4 border-t bg-muted/10 shrink-0">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={updateContinuity.isPending} data-testid="button-save-continuity">
                {updateContinuity.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save Continuity Settings
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}