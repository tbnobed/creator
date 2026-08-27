import { useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { 
  useGetLongFormProject,
  useStartLongFormProject,
  useReassembleLongFormProject,
  usePauseLongFormProject,
  useCancelLongFormProject,
  useUpdateLongFormShot,
  useRetryLongFormShot,
  getGetLongFormProjectQueryKey,
  getListLongFormProjectsQueryKey,
  useDeleteLongFormProject
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";

import {
  Play,
  Pause,
  XCircle,
  RefreshCw,
  Film,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  Trash2,
  MoreVertical
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export default function ProjectDetailPage() {
  const [, params] = useRoute("/projects/:id");
  const [, setLocation] = useLocation();
  const id = params?.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editingShot, setEditingShot] = useState<any>(null);

  // Queries
  const { data: project, isLoading, error } = useGetLongFormProject(id as string, {
    query: {
      enabled: !!id,
      queryKey: getGetLongFormProjectQueryKey(id as string),
      // Poll if running or assembling
      refetchInterval: (query) => {
        const p = query.state.data as any;
        if (!p) return false;
        return ["RUNNING", "ASSEMBLING"].includes(p.status) ? 3000 : false;
      }
    }
  });

  // Mutations
  const startProject = useStartLongFormProject();
  const reassembleProject = useReassembleLongFormProject();
  const pauseProject = usePauseLongFormProject();
  const cancelProject = useCancelLongFormProject();
  const deleteProject = useDeleteLongFormProject();
  const retryShot = useRetryLongFormShot();

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: getGetLongFormProjectQueryKey(id as string) });
  };

  const handleStart = () => {
    if (!id) return;
    startProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Production started" });
        invalidateProject();
      },
      onError: (err: any) => toast({ title: "Failed to start", description: err.message, variant: "destructive" })
    });
  };

  const handlePause = () => {
    if (!id) return;
    pauseProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Production paused" });
        invalidateProject();
      },
      onError: (err: any) => toast({ title: "Failed to pause", description: err.message, variant: "destructive" })
    });
  };

  const handleReassemble = () => {
    if (!id || !window.confirm("Rebuild the final video from the completed shots? Existing shot renders will be reused.")) return;
    reassembleProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Reassembly started", description: "Rebuilding the final video with audio from the existing shots." });
        invalidateProject();
      },
      onError: (err: any) => toast({ title: "Failed to reassemble", description: err.message, variant: "destructive" })
    });
  };

  const handleCancel = () => {
    if (!id) return;
    cancelProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Production cancelled" });
        invalidateProject();
      },
      onError: (err: any) => toast({ title: "Failed to cancel", description: err.message, variant: "destructive" })
    });
  };

  const handleDelete = () => {
    if (!id || !window.confirm(`Delete "${project?.title ?? "this project"}"? This removes the project, its shot plan, and project-only generated media.`)) return;
    deleteProject.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListLongFormProjectsQueryKey() });
        toast({ title: "Project deleted" });
        setLocation("/projects");
      },
      onError: (err: any) => toast({ title: "Failed to delete project", description: err.message, variant: "destructive" }),
    });
  };

  const handleRetryShot = (shotId: string) => {
    retryShot.mutate({ id: id as string, shotId }, {
      onSuccess: () => {
        toast({ title: "Shot queued for retry" });
        invalidateProject();
      },
      onError: (err: any) => toast({ title: "Failed to retry shot", description: err.message, variant: "destructive" })
    });
  };

  if (!id) return null;
  
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-4 md:p-8">
        <div className="bg-destructive/10 text-destructive p-6 rounded-xl border border-destructive/20 max-w-lg mx-auto text-center">
          <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
          <h2 className="text-xl font-bold">Failed to load project</h2>
          <p className="mt-2 opacity-80 text-sm">{(error as any)?.message || "Not found"}</p>
          <Link href="/projects">
            <Button variant="outline" className="mt-6">Back to Projects</Button>
          </Link>
        </div>
      </div>
    );
  }

  const isRunning = project.status === "RUNNING";
  const isPaused = project.status === "PAUSED";
  const isReady = project.status === "READY";
  const isDraft = project.status === "DRAFT";
  const isDone = project.status === "COMPLETED";

  // Group shots by scene
  const scenes = project.shots.reduce((acc: any, shot: any) => {
    if (!acc[shot.sceneNumber]) acc[shot.sceneNumber] = [];
    acc[shot.sceneNumber].push(shot);
    return acc;
  }, {});

  const getShotStatusIcon = (status: string) => {
    switch (status) {
      case "COMPLETED": return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case "FAILED": return <AlertTriangle className="w-4 h-4 text-destructive" />;
      case "RENDERING": return <Loader2 className="w-4 h-4 animate-spin text-primary" />;
      case "QUEUED": return <RefreshCw className="w-4 h-4 text-amber-500" />;
      default: return <Film className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* HEADER */}
      <header className="flex-none border-b border-border/50 bg-card/30 backdrop-blur px-4 py-4 md:px-8 md:py-6">
        <Link href="/projects" className="inline-flex items-center text-xs md:text-sm text-muted-foreground hover:text-foreground mb-3 md:mb-4 transition-colors">
          <ArrowLeft className="mr-1.5 md:mr-2 h-3.5 w-3.5 md:h-4 md:w-4" />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 md:gap-6">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-1.5 md:mb-2">
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight break-words pr-2">{project.title}</h1>
              <span className={`px-2 md:px-2.5 py-0.5 md:py-1 text-[10px] md:text-xs font-bold uppercase tracking-wider rounded border ${
                project.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' :
                project.status === 'FAILED' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                project.status === 'RUNNING' || project.status === 'ASSEMBLING' ? 'bg-primary/10 text-primary border-primary/20 animate-pulse' :
                'bg-muted text-muted-foreground border-border'
              }`}>
                {project.status}
              </span>
            </div>
            
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:gap-6 text-xs md:text-sm text-muted-foreground">
              <span>{project.width}x{project.height} @ {project.fps}fps</span>
              <span className="hidden md:inline">•</span>
              <span>{project.totalShots} Shots</span>
              <span className="hidden md:inline">•</span>
              <span>{project.targetDurationSeconds}s target</span>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            {(isReady || isPaused || isDraft) && (
              <Button onClick={handleStart} disabled={startProject.isPending} size="sm" className="md:h-10 md:px-4 brand-glow bg-primary hover:bg-primary/90 text-white font-semibold shadow-lg text-xs md:text-sm">
                <Play className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2" /> Start<span className="hidden sm:inline">&nbsp;Production</span>
              </Button>
            )}

            {isDone && (
              <Button onClick={handleReassemble} disabled={reassembleProject.isPending} size="sm" variant="secondary" className="md:h-10 md:px-4 text-xs md:text-sm">
                {reassembleProject.isPending
                  ? <Loader2 className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2" />}
                Reassemble<span className="hidden sm:inline">&nbsp;Video</span>
              </Button>
            )}
            
            {isRunning && (
              <Button onClick={handlePause} disabled={pauseProject.isPending} size="sm" variant="secondary" className="md:h-10 md:px-4 text-xs md:text-sm">
                <Pause className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2" /> Pause
              </Button>
            )}

            {(isRunning || isPaused || isReady) && (
              <Button onClick={handleCancel} disabled={cancelProject.isPending} size="sm" variant="outline" className="md:h-10 md:px-4 text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/20 text-xs md:text-sm">
                <XCircle className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2" /> Cancel
              </Button>
            )}

            {/* Desktop Delete */}
            <div className="hidden md:block">
              {!isRunning && project.status !== "ASSEMBLING" && (
                <Button
                  onClick={handleDelete}
                  disabled={deleteProject.isPending}
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/20"
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              )}
            </div>

            {/* Mobile Actions Menu */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-9 w-9">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!isRunning && project.status !== "ASSEMBLING" && (
                    <DropdownMenuItem onClick={handleDelete} disabled={deleteProject.isPending} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                      <Trash2 className="w-4 h-4 mr-2" /> Delete Project
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* PROGRESS */}
        <div className="mt-5 md:mt-8 bg-black/40 border border-border/50 rounded-xl p-4 md:p-5 shadow-inner">
          <div className="flex justify-between items-end mb-2 md:mb-3">
            <span className="text-xs md:text-sm font-medium text-muted-foreground">Overall Progress</span>
            <span className="text-lg md:text-xl font-bold text-foreground">{Math.round(project.progress)}%</span>
          </div>
          <div className="relative w-full h-2.5 md:h-3 bg-secondary rounded-full overflow-hidden">
            <div 
              className={`absolute top-0 left-0 h-full transition-all duration-1000 ease-out ${
                project.status === 'FAILED' ? 'bg-destructive' : 'bg-primary'
              }`}
              style={{ width: `${project.progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-2.5 md:mt-3 text-[10px] md:text-xs text-muted-foreground">
            <span className="flex items-center gap-1 md:gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-500" /> {project.completedShots} completed</span>
            {project.failedShots > 0 && <span className="flex items-center gap-1 md:gap-1.5 text-destructive"><AlertTriangle className="w-3 h-3" /> {project.failedShots} failed</span>}
            <span className="flex items-center gap-1 md:gap-1.5 opacity-60"><Film className="w-3 h-3" /> {project.totalShots} total</span>
          </div>
        </div>
      </header>

      {/* CONTENT */}
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 flex flex-col lg:grid lg:grid-cols-12 gap-6 md:gap-8 pb-10">
        
        {/* RIGHT PANEL (takes 4 cols) - Move above shot list on mobile */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-4 md:space-y-6 order-1 lg:order-2">
          
          <div className="bg-card rounded-xl border border-card-border overflow-hidden lg:sticky lg:top-8">
            <div className="p-3 md:p-4 border-b border-border/50 bg-muted/20">
              <h2 className="text-sm md:text-base font-semibold flex items-center gap-2">
                <Play className="w-4 h-4 text-primary" />
                Final Output
              </h2>
            </div>
            <div className="p-3 md:p-4">
              {project.finalOutputUrl ? (
                <div className="w-full rounded-lg overflow-hidden border border-border shadow-lg bg-black">
                  <video src={project.finalOutputUrl} controls className="w-full" playsInline />
                </div>
              ) : project.status === 'ASSEMBLING' ? (
                <div className="w-full aspect-video rounded-lg border border-primary/30 bg-primary/5 flex flex-col items-center justify-center animate-pulse shadow-[0_0_15px_rgba(255,31,98,0.2)] text-primary">
                  <Loader2 className="w-6 h-6 md:w-8 md:h-8 animate-spin mb-2 md:mb-3" />
                  <p className="font-medium tracking-wide text-xs md:text-sm">Assembling Final Cut...</p>
                </div>
              ) : (
                <div className="w-full aspect-video rounded-lg border border-border bg-black/50 flex flex-col items-center justify-center text-muted-foreground/50">
                  <Film className="w-6 h-6 md:w-8 md:h-8 mb-2 md:mb-3" />
                  <p className="text-xs md:text-sm">Final render will appear here</p>
                </div>
              )}

              {project.errorMessage && (
                <div className="mt-3 md:mt-4 bg-destructive/10 border border-destructive/20 rounded-lg p-2.5 md:p-3 text-xs md:text-sm text-destructive flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="break-words">{project.errorMessage}</p>
                </div>
              )}
            </div>

            <div className="border-t border-border/50 bg-muted/10 p-3 md:p-4">
              <h3 className="text-[10px] md:text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 md:mb-3">Script & Storyline</h3>
              <div className="text-sm text-foreground/80 max-h-48 md:max-h-60 overflow-y-auto pr-2 space-y-3 md:space-y-4">
                <div>
                  <h4 className="text-[10px] md:text-xs text-muted-foreground mb-1">Storyline Direction</h4>
                  <p className="italic text-xs md:text-sm text-muted-foreground">{project.storyline || "No overarching storyline provided."}</p>
                </div>
                <div>
                  <h4 className="text-[10px] md:text-xs text-muted-foreground mb-1">Original Script</h4>
                  <div className="whitespace-pre-wrap font-mono text-[10px] md:text-[11px] leading-relaxed opacity-70">
                    {project.script}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* SHOT LIST (Left side, takes 8 cols) - Order 2 on mobile */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-6 md:space-y-8 order-2 lg:order-1">
          <div className="flex items-center justify-between">
            <h2 className="text-lg md:text-xl font-semibold flex items-center gap-2">
              <Film className="w-4 h-4 md:w-5 md:h-5 text-primary" />
              Shot Plan
            </h2>
          </div>

          <div className="space-y-6 md:space-y-8">
            {Object.keys(scenes).sort((a, b) => Number(a) - Number(b)).map(sceneNum => (
              <div key={sceneNum} className="space-y-3 md:space-y-4">
                <h3 className="text-xs md:text-sm font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50 pb-2">
                  Scene {sceneNum}
                </h3>
                <div className="grid gap-2.5 md:gap-3">
                  {scenes[sceneNum].sort((a: any, b: any) => a.shotNumber - b.shotNumber).map((shot: any) => (
                    <div 
                      key={shot.id} 
                      className={`group flex items-start gap-3 md:gap-4 p-3 md:p-4 rounded-xl border transition-all ${
                        shot.status === 'FAILED' ? 'bg-destructive/5 border-destructive/30' :
                        shot.status === 'RENDERING' ? 'bg-primary/5 border-primary/30' :
                        shot.status === 'COMPLETED' ? 'bg-card border-emerald-500/20' :
                        'bg-card border-card-border md:hover:border-primary/50'
                      }`}
                    >
                      <div className="w-20 md:w-24 flex-shrink-0">
                        {shot.outputUrl ? (
                          <div className="w-full aspect-video bg-black rounded-md overflow-hidden relative border border-border">
                            <video src={shot.outputUrl} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                          </div>
                        ) : (
                          <div className="w-full aspect-video bg-muted rounded-md flex flex-col items-center justify-center border border-border">
                            {getShotStatusIcon(shot.status)}
                          </div>
                        )}
                        <div className="text-center mt-1.5 md:mt-2 text-[10px] md:text-xs font-mono text-muted-foreground">
                          {shot.durationSeconds}s
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1 md:mb-1.5 gap-2">
                          <h4 className="font-semibold text-sm md:text-base text-foreground flex items-center gap-1.5 md:gap-2 truncate">
                            <span className="truncate">{shot.title || `Shot ${shot.sceneNumber}.${shot.shotNumber}`}</span>
                            {shot.status === 'FAILED' && <span className="flex-shrink-0 text-[9px] md:text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">Failed</span>}
                          </h4>
                          
                          <div className="flex items-center gap-1 md:gap-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0 -mr-1 md:mr-0 -mt-1 md:mt-0">
                            {shot.status === 'FAILED' && (
                              <Button size="icon" variant="ghost" className="w-7 h-7 md:w-7 md:h-7 text-amber-500" onClick={() => handleRetryShot(shot.id)}>
                                <RefreshCw className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="w-7 h-7 md:w-7 md:h-7" onClick={() => setEditingShot(shot)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                        
                        <p className="text-xs md:text-sm text-muted-foreground line-clamp-3 md:line-clamp-2 leading-relaxed">
                          {shot.prompt}
                        </p>
                        
                        {shot.errorMessage && (
                          <div className="mt-2 md:mt-2.5 text-[10px] md:text-xs text-destructive bg-destructive/10 p-2 rounded">
                            {shot.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
      
      {editingShot && (
        <EditShotDialog 
          shot={editingShot} 
          open={!!editingShot} 
          onOpenChange={(open) => !open && setEditingShot(null)}
          projectId={project.id}
        />
      )}
    </div>
  );
}

const shotFormSchema = z.object({
  title: z.string().min(1).max(180).optional(),
  prompt: z.string().min(1).max(10000).optional(),
  dialogue: z.string().max(5000).optional(),
  cameraInstructions: z.string().max(5000).optional(),
  motionInstructions: z.string().max(5000).optional(),
  continuityNote: z.string().max(5000).optional(),
  transition: z.enum(["CUT", "DISSOLVE", "FADE"]).optional(),
  durationSeconds: z.coerce.number().min(2).max(30).optional(),
});

function EditShotDialog({ shot, open, onOpenChange, projectId }: { shot: any, open: boolean, onOpenChange: (o: boolean) => void, projectId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateShot = useUpdateLongFormShot();

  const form = useForm<z.infer<typeof shotFormSchema>>({
    resolver: zodResolver(shotFormSchema),
    defaultValues: {
      title: shot.title || "",
      prompt: shot.prompt || "",
      dialogue: shot.dialogue || "",
      cameraInstructions: shot.cameraInstructions || "",
      motionInstructions: shot.motionInstructions || "",
      continuityNote: shot.continuityNote || "",
      transition: shot.transition || "CUT",
      durationSeconds: shot.durationSeconds || 5,
    }
  });

  const onSubmit = (data: z.infer<typeof shotFormSchema>) => {
    updateShot.mutate({ id: projectId, shotId: shot.id, data }, {
      onSuccess: () => {
        toast({ title: "Shot updated" });
        queryClient.invalidateQueries({ queryKey: getGetLongFormProjectQueryKey(projectId) });
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ title: "Failed to update shot", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto w-[95vw] p-4 md:p-6">
        <DialogHeader>
          <DialogTitle className="text-lg md:text-xl">Edit Shot {shot.sceneNumber}.{shot.shotNumber}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 md:space-y-6 mt-2 md:mt-4">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs md:text-sm">Title</FormLabel>
                    <FormControl>
                      <Input className="h-9 md:h-10 text-sm" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="durationSeconds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs md:text-sm">Duration (seconds)</FormLabel>
                    <FormControl>
                      <Input className="h-9 md:h-10 text-sm" type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs md:text-sm">Base Prompt</FormLabel>
                  <FormControl>
                    <Textarea className="h-24 md:h-32 text-sm resize-none" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
              <FormField
                control={form.control}
                name="cameraInstructions"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs md:text-sm">Camera Motion</FormLabel>
                    <FormControl>
                      <Input className="h-9 md:h-10 text-sm" placeholder="e.g. Slow pan right" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="motionInstructions"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs md:text-sm">Subject Motion</FormLabel>
                    <FormControl>
                      <Input className="h-9 md:h-10 text-sm" placeholder="e.g. Character turns head" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="continuityNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs md:text-sm">Continuity Note</FormLabel>
                  <FormControl>
                    <Input className="h-9 md:h-10 text-sm" placeholder="Ensure character wears hat" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2.5 md:gap-3 pt-3 md:pt-4 border-t border-border">
              <Button type="button" variant="outline" size="sm" className="md:h-10 md:px-4" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={updateShot.isPending} size="sm" className="md:h-10 md:px-4 brand-glow">
                {updateShot.isPending && <Loader2 className="w-3.5 h-3.5 md:w-4 md:h-4 mr-1.5 md:mr-2 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
