import { useLocation, Link } from "wouter";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import {
  useCreateLongFormProject,
  useListCharacters,
  useListSettings,
  useListWorkflows,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Wand2 } from "lucide-react";

const formSchema = z.object({
  title: z.string().min(1, "Title is required").max(180),
  script: z.string().min(1, "Script is required").max(100000),
  storyline: z.string().max(20000).optional(),
  targetDurationSeconds: z.coerce.number().min(1).max(600),
  shotDurationSeconds: z.coerce.number().min(2).max(30).optional(),
  characterIds: z.array(z.string()).min(1, "Select at least one character").max(9),
  settingId: z.string().min(1, "Setting is required"),
  generationMode: z.string().min(1, "Workflow/generation mode is required"),
  negativePrompt: z.string().max(5000).optional(),
  width: z.coerce.number().min(64).max(4096),
  height: z.coerce.number().min(64).max(4096),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  qualityPreset: z.enum(["DRAFT", "STANDARD", "HIGH"]),
});

type FormValues = z.infer<typeof formSchema>;

export default function NewProjectPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const { data: characters = [] } = useListCharacters();
  const { data: settings = [] } = useListSettings();
  const { data: workflows = [] } = useListWorkflows();
  const workflowModes = workflows.filter(
    (workflow, index, collection) =>
      collection.findIndex((candidate) => candidate.generationMode === workflow.generationMode) === index,
  );

  const createProject = useCreateLongFormProject();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      script: "",
      storyline: "",
      targetDurationSeconds: 60,
      shotDurationSeconds: 5,
      characterIds: [],
      settingId: "",
      generationMode: "",
      negativePrompt: "text, watermark, ugly, deformed, noisy, blurry",
      width: 1280,
      height: 720,
      fps: 24,
      qualityPreset: "STANDARD",
    },
  });

  const onSubmit = (values: FormValues) => {
    createProject.mutate(
      { data: values },
      {
        onSuccess: (project) => {
          toast({
            title: "Project created",
            description: "Your script is being broken down into shots.",
          });
          setLocation(`/projects/${project.id}`);
        },
        onError: (err: any) => {
          toast({
            title: "Failed to create project",
            description: err.message || "An unexpected error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-background/50">
      <div className="max-w-4xl mx-auto px-8 py-10">
        <Link href="/projects" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Projects
        </Link>
        
        <div className="mb-10">
          <h1 className="text-4xl font-extrabold tracking-tight mb-2 text-transparent bg-clip-text bg-gradient-to-br from-white to-white/60">
            New Long-Form Project
          </h1>
          <p className="text-muted-foreground text-lg">
            Provide a script and set the creative direction. Our AI will automatically break it down into a sequence of renderable shots.
          </p>
        </div>

        <div className="bg-card/50 backdrop-blur-xl border border-card-border rounded-xl p-8 shadow-2xl">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-10">
              
              {/* CORE INFO */}
              <div className="space-y-6">
                <div className="flex items-center border-b border-border/50 pb-2 mb-6">
                  <h2 className="text-xl font-semibold">Narrative</h2>
                </div>
                
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project Title</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. The Neon Syndicate" className="text-lg px-4 py-6" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="script"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Script</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="Enter the complete script..." 
                            className="h-64 font-mono text-sm resize-none" 
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="storyline"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Visual Storyline (Optional)</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="Provide overarching visual directions, mood, and aesthetic rules to guide the shot breakdown..." 
                            className="h-64 resize-none" 
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* CAST & CREW */}
              <div className="space-y-6">
                <div className="flex items-center border-b border-border/50 pb-2 mb-6">
                  <h2 className="text-xl font-semibold">Cast & Location</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="settingId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Primary Setting</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a setting" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {settings.map(s => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="characterIds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Characters (Select up to 9)</FormLabel>
                        <FormControl>
                          <div className="flex flex-wrap gap-2 pt-2">
                            {characters.length === 0 && <span className="text-sm text-muted-foreground">No characters available</span>}
                            {characters.map(c => {
                              const isSelected = field.value.includes(c.id);
                              return (
                                <button
                                  type="button"
                                  key={c.id}
                                  onClick={() => {
                                    const next = isSelected 
                                      ? field.value.filter(id => id !== c.id)
                                      : [...field.value, c.id].slice(0, 9);
                                    field.onChange(next);
                                  }}
                                  className={`px-3 py-1.5 text-sm rounded-full border transition-all ${
                                    isSelected 
                                      ? "bg-primary/20 border-primary text-primary" 
                                      : "bg-transparent border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground"
                                  }`}
                                >
                                  {c.name}
                                </button>
                              )
                            })}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* TECHNICAL SETTINGS */}
              <div className="space-y-6">
                <div className="flex items-center border-b border-border/50 pb-2 mb-6">
                  <h2 className="text-xl font-semibold">Technical Specs</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <FormField
                    control={form.control}
                    name="generationMode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Workflow</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {workflowModes.map((workflow) => (
                              <SelectItem key={workflow.generationMode} value={workflow.generationMode}>{workflow.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="targetDurationSeconds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Total Target Length (s)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="shotDurationSeconds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Avg Shot Length (s)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="qualityPreset"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Quality Preset</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="DRAFT">Draft</SelectItem>
                            <SelectItem value="STANDARD">Standard</SelectItem>
                            <SelectItem value="HIGH">High</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <FormField
                    control={form.control}
                    name="width"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Width (px)</FormLabel>
                        <FormControl>
                          <Input type="number" step={64} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="height"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Height (px)</FormLabel>
                        <FormControl>
                          <Input type="number" step={64} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="fps"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Framerate (fps)</FormLabel>
                        <Select 
                          onValueChange={(val) => field.onChange(parseInt(val, 10))} 
                          defaultValue={field.value.toString()}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="24">24 fps (Cinematic)</SelectItem>
                            <SelectItem value="25">25 fps (PAL)</SelectItem>
                            <SelectItem value="30">30 fps (Standard)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="pt-8 border-t border-border/50 flex justify-end">
                <Button 
                  type="submit" 
                  size="lg"
                  disabled={createProject.isPending}
                  className="w-full md:w-auto min-w-[200px] brand-glow hover-elevate font-semibold"
                >
                  {createProject.isPending ? (
                    <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Generating Plan...</>
                  ) : (
                    <><Wand2 className="mr-2 h-5 w-5" /> Generate Project Plan</>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
