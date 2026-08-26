import { useListLongFormProjects } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Plus, Clapperboard, Clock, AlertTriangle, CheckCircle2, PlayCircle, Loader2, Film } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function ProjectsPage() {
  const { data: projects = [], isLoading, error } = useListLongFormProjects();

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
      case "COMPLETED": return <CheckCircle2 className="w-4 h-4" />;
      case "FAILED": return <AlertTriangle className="w-4 h-4" />;
      case "RUNNING": return <Loader2 className="w-4 h-4 animate-spin" />;
      case "ASSEMBLING": return <Loader2 className="w-4 h-4 animate-spin" />;
      case "READY": return <PlayCircle className="w-4 h-4" />;
      default: return <Clapperboard className="w-4 h-4" />;
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background">
      <div className="max-w-7xl mx-auto">
        
        <div className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight">Productions</h1>
            <p className="text-muted-foreground mt-2">Manage long-form AI video projects and shot plans.</p>
          </div>
          <Link href="/projects/new">
            <Button size="lg" className="brand-glow hover-elevate font-semibold">
              <Plus className="mr-2 w-5 h-5" />
              New Production
            </Button>
          </Link>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-[280px] bg-card/50 rounded-xl animate-pulse border border-border/50" />
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center border rounded-xl bg-destructive/10 text-destructive border-destructive/20">
            <AlertTriangle className="w-10 h-10 mx-auto mb-4 opacity-80" />
            <p className="font-medium">Failed to load projects.</p>
            <p className="text-sm opacity-80 mt-1">{(error as any)?.message}</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-24 px-6 border border-dashed rounded-xl bg-card/20">
            <Film className="w-16 h-16 mx-auto mb-6 text-muted-foreground/30" />
            <h2 className="text-2xl font-bold mb-2">No productions yet</h2>
            <p className="text-muted-foreground max-w-md mx-auto mb-8">
              Start by creating a new long-form production. Provide a script and let the AI break it down into a shot plan.
            </p>
            <Link href="/projects/new">
              <Button size="lg" className="brand-glow">
                <Plus className="mr-2 w-5 h-5" /> Create First Production
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map(project => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <div className="group relative flex flex-col h-full bg-card rounded-xl border border-card-border overflow-hidden hover:border-primary/50 transition-all hover-elevate cursor-pointer">
                  
                  {project.finalOutputUrl ? (
                    <div className="h-48 w-full bg-black relative">
                      <video 
                        src={project.finalOutputUrl}
                        className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity"
                        autoPlay muted loop playsInline
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    </div>
                  ) : (
                    <div className="h-40 w-full bg-muted/30 relative flex items-center justify-center">
                      <Clapperboard className="w-12 h-12 text-muted-foreground/20" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    </div>
                  )}

                  <div className="p-5 flex flex-col flex-1 relative -mt-10">
                    <h3 className="text-xl font-bold text-white mb-1 line-clamp-1 drop-shadow-md">
                      {project.title}
                    </h3>
                    
                    <div className="flex items-center gap-4 mt-3 mb-6 text-sm">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="w-4 h-4" />
                        {project.targetDurationSeconds}s target
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clapperboard className="w-4 h-4" />
                        {project.totalShots} shots
                      </div>
                    </div>

                    <div className="mt-auto">
                      <div className="flex justify-between items-end mb-2">
                        <span className={`text-xs font-medium uppercase tracking-wider flex items-center gap-1.5 ${getStatusColor(project.status)}`}>
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
                      
                      <div className="flex justify-between items-center mt-4 pt-4 border-t border-border/50 text-xs text-muted-foreground">
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
