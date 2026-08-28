import { getListLongFormProjectsQueryKey, useDeleteLongFormProject, useListLongFormProjects } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type { MouseEvent } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Plus, Clapperboard, Clock, AlertTriangle, CheckCircle2, PlayCircle, Loader2, Film, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function ProjectsPage() {
  const { data: projects = [], isLoading, error } = useListLongFormProjects();
  const queryClient = useQueryClient();
  const deleteProject = useDeleteLongFormProject();

  const handleDelete = (event: MouseEvent, projectId: string, title: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!window.confirm(`Delete "${title}"? This removes the project, its shot plan, and any project-only generated media.`)) return;
    deleteProject.mutate({ id: projectId }, {
      onSuccess: () => {
        queryClient.setQueryData(
          getListLongFormProjectsQueryKey(),
          (current: typeof projects) => current.filter((project) => project.id !== projectId),
        );
        void queryClient.invalidateQueries({ queryKey: getListLongFormProjectsQueryKey() });
      },
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "COMPLETED": return "text-emerald-500";
      case "FAILED": return "text-destructive";
      case "RUNNING": return "text-primary animate-pulse";
      case "ASSEMBLING": return "text-primary";
      case "PAUSED": return "text-amber-500";
      default: return "text-muted-foreground";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "COMPLETED": return <CheckCircle2 className="w-3 h-3 md:w-4 md:h-4" />;
      case "FAILED": return <AlertTriangle className="w-3 h-3 md:w-4 md:h-4" />;
      case "RUNNING": return <Loader2 className="w-3 h-3 md:w-4 md:h-4 animate-spin" />;
      case "ASSEMBLING": return <Loader2 className="w-3 h-3 md:w-4 md:h-4 animate-spin" />;
      case "READY": return <PlayCircle className="w-3 h-3 md:w-4 md:h-4" />;
      default: return <Clapperboard className="w-3 h-3 md:w-4 md:h-4" />;
    }
  };

  return (
    <div className="w-full p-4 md:p-8 bg-background pb-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 md:mb-10 gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Productions</h1>
            <p className="text-muted-foreground mt-1 md:mt-2 text-sm md:text-base">Manage long-form AI video projects and shot plans.</p>
          </div>
          <Link href="/projects/new">
            <Button size="lg" className="brand-glow hover-elevate font-semibold w-full sm:w-auto h-12 md:h-11">
              <Plus className="mr-2 w-5 h-5" />
              New Production
            </Button>
          </Link>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-[280px] bg-card/50 rounded-xl animate-pulse border border-border/50" />
            ))}
          </div>
        ) : error ? (
          <div className="p-6 md:p-8 text-center border rounded-xl bg-destructive/10 text-destructive border-destructive/20 mx-auto max-w-xl">
            <AlertTriangle className="w-10 h-10 mx-auto mb-4 opacity-80" />
            <p className="font-medium">Failed to load projects.</p>
            <p className="text-sm opacity-80 mt-1">{(error as any)?.message}</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16 md:py-24 px-4 md:px-6 border border-dashed rounded-xl bg-card/20 mx-auto max-w-2xl">
            <Film className="w-12 h-12 md:w-16 md:h-16 mx-auto mb-4 md:mb-6 text-muted-foreground/30" />
            <h2 className="text-xl md:text-2xl font-bold mb-2">No productions yet</h2>
            <p className="text-sm md:text-base text-muted-foreground max-w-md mx-auto mb-6 md:mb-8">
              Start by creating a new long-form production. Provide a script and let the AI break it down into a shot plan.
            </p>
            <Link href="/projects/new">
              <Button size="lg" className="brand-glow w-full sm:w-auto">
                <Plus className="mr-2 w-5 h-5" /> Create First Production
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
            {projects.map(project => (
              <div key={project.id} className="relative h-full w-full">
                <Link href={`/projects/${project.id}`} className="block h-full">
                <div className="group relative flex flex-col h-full bg-card rounded-xl border border-card-border overflow-hidden hover:border-primary/50 transition-all md:hover-elevate cursor-pointer">
                  
                  {project.finalOutputUrl ? (
                    <div className="h-40 md:h-48 w-full bg-black relative">
                      <video 
                        src={project.finalOutputUrl}
                        className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity"
                        muted loop playsInline preload="none"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    </div>
                  ) : (
                    <div className="h-36 md:h-40 w-full bg-muted/30 relative flex items-center justify-center">
                      <Clapperboard className="w-10 h-10 md:w-12 md:h-12 text-muted-foreground/20" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    </div>
                  )}

                  <div className="p-4 md:p-5 flex flex-col flex-1 relative -mt-8 md:-mt-10">
                    <h3 className="text-lg md:text-xl font-bold text-white mb-1 line-clamp-1 drop-shadow-md pr-8">
                      {project.title}
                    </h3>
                    
                    <div className="flex items-center gap-3 md:gap-4 mt-2 md:mt-3 mb-5 md:mb-6 text-xs md:text-sm">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 md:w-4 md:h-4" />
                        {project.targetDurationSeconds}s target
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clapperboard className="w-3.5 h-3.5 md:w-4 md:h-4" />
                        {project.totalShots} shots
                      </div>
                    </div>

                    <div className="mt-auto">
                      <div className="flex justify-between items-end mb-2">
                        <span className={`text-[10px] md:text-xs font-medium uppercase tracking-wider flex items-center gap-1.5 ${getStatusColor(project.status)}`}>
                          {getStatusIcon(project.status)}
                          {project.status}
                        </span>
                        <span className="text-xs font-medium text-foreground/80">
                          {Math.round(project.progress)}%
                        </span>
                      </div>
                      
                      <div className="relative w-full h-2 bg-secondary rounded-full overflow-hidden">
                        <div 
                          className={`absolute top-0 left-0 h-full transition-all duration-500 ${
                            project.status === 'FAILED' ? 'bg-destructive' : 'bg-primary'
                          }`}
                          style={{ width: `${project.progress}%` }}
                        />
                      </div>
                      
                      <div className="flex justify-between items-center mt-3 md:mt-4 pt-3 md:pt-4 border-t border-border/50 text-[10px] md:text-xs text-muted-foreground">
                        <span>{project.completedShots} / {project.totalShots} done</span>
                        {project.failedShots > 0 && (
                          <span className="text-destructive font-medium">{project.failedShots} failed</span>
                        )}
                        <span>{formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                </div>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 md:right-3 md:top-3 z-10 w-8 h-8 md:w-10 md:h-10 bg-background/80 text-muted-foreground shadow-sm backdrop-blur hover:bg-destructive/15 hover:text-destructive"
                  onClick={(event) => handleDelete(event, project.id, project.title)}
                  disabled={deleteProject.isPending || ["RUNNING", "ASSEMBLING"].includes(project.status)}
                  title={["RUNNING", "ASSEMBLING"].includes(project.status) ? "Stop the active project before deleting it" : "Delete project"}
                  aria-label={["RUNNING", "ASSEMBLING"].includes(project.status) ? "Stop the active project before deleting it" : `Delete ${project.title}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
