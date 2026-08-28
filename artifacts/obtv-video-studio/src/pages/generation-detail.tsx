import { useGetGeneration } from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { useParams, Link, useLocation } from "wouter";
import { getGetGenerationQueryKey } from "@workspace/api-client-react";
import { ArrowLeft, Loader2, Video, AlertTriangle, Info, Clock, PlayCircle, HardDrive, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { format } from "date-fns";

export default function GenerationDetailPage() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = params.id as string;
  const { data: job, isLoading } = useGetGeneration(id, {
    query: {
      enabled: !!id,
      queryKey: getGetGenerationQueryKey(id),
      refetchInterval: (query) => {
        const currentJob = query.state.data;
        return currentJob && ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(currentJob.status) ? 2_000 : false;
      },
    },
  });

  if (isLoading) {
    return (
      <Page>
        <div className="flex items-center gap-4 mb-8 text-muted-foreground">
          <Link href="/generations">
            <Button variant="ghost" size="icon"><ArrowLeft className="size-4" /></Button>
          </Link>
          <div className="h-8 w-64 bg-card animate-pulse rounded" />
        </div>
        <div className="h-[400px] w-full bg-card animate-pulse rounded-lg" />
      </Page>
    );
  }

  if (!job) {
    return <Page><div>Job not found.</div></Page>;
  }

  const isRunning = ["RUNNING", "QUEUED", "UPLOADING", "DOWNLOADING"].includes(job.status);
  const isFailed = job.status === "FAILED";
  const isCompleted = job.status === "COMPLETED";

  return (
    <Page>
      <div className="flex items-center gap-4 mb-6">
        <Link href="/generations">
          <Button variant="ghost" size="icon"><ArrowLeft className="size-4" /></Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            {job.title || "Untitled Job"}
            <StatusBadge status={job.status} />
          </h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">ID: {job.id}</p>
        </div>
        {!isRunning && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setLocation(`/?cloneJob=${encodeURIComponent(job.id)}`)}
          >
            <Pencil className="size-4" />
            Edit & Regenerate
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Main Display Area */}
          <Card className="overflow-hidden border-border/50 bg-card/30 backdrop-blur-sm">
            <div className="aspect-video bg-black flex flex-col items-center justify-center relative">
              {isCompleted && job.outputUrl ? (
                <video 
                  src={job.outputUrl} 
                  controls 
                  loop 
                  preload="none"
                  className="w-full h-full object-contain"
                />
              ) : isRunning ? (
                <div className="flex flex-col items-center justify-center text-primary gap-4">
                  <Loader2 className="size-12 animate-spin" />
                  <div className="text-center">
                    <p className="font-medium text-lg mb-2">Processing...</p>
                    <div className="w-64 space-y-2">
                      {job.progress !== null && job.progress !== undefined ? (
                        <Progress value={job.progress * 100} className="h-2" />
                      ) : (
                        <div className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20">
                          <div className="h-full w-1/3 rounded-full bg-primary animate-pulse" />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {job.progress !== null && job.progress !== undefined ? `${(job.progress * 100).toFixed(0)}% complete` : "Waiting for worker progress..."}
                      </p>
                    </div>
                    {job.currentNode && (
                      <p className="text-xs font-mono text-muted-foreground mt-2">Node: {job.currentNode}</p>
                    )}
                  </div>
                </div>
              ) : isFailed ? (
                <div className="flex flex-col items-center justify-center text-destructive gap-4 p-8 text-center">
                  <AlertTriangle className="size-12" />
                  <div>
                    <p className="font-bold text-lg mb-1">Generation Failed</p>
                    <p className="text-sm font-mono bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md max-w-lg">
                      {job.errorMessage || "Unknown error occurred"}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-muted-foreground gap-4">
                  <PlayCircle className="size-12 opacity-50" />
                  <p>Job is {job.status.toLowerCase()}</p>
                </div>
              )}
            </div>
          </Card>

          <Card className="p-5 border-border/50 bg-card/30">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Info className="size-4 text-primary" /> Prompts
            </h3>
            <div className="space-y-4">
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">User Prompt</span>
                <p className="text-sm bg-secondary/20 p-3 rounded-md border border-border/50">{job.prompt}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">Compiled System Prompt</span>
                <p className="text-xs font-mono bg-secondary/20 p-3 rounded-md border border-border/50 text-muted-foreground overflow-x-auto max-h-40 overflow-y-auto">
                  {job.compiledPrompt}
                </p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5 border-border/50 bg-card/30">
            <h3 className="font-semibold mb-4">Job Details</h3>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Quality</dt>
                <dd className="font-medium">{job.qualityPreset}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Resolution</dt>
                <dd className="font-medium font-mono">{job.width}x{job.height}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Framerate</dt>
                <dd className="font-medium">{job.fps} fps</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="font-medium">{job.durationSeconds} sec</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Seed</dt>
                <dd className="font-medium font-mono">{job.seed || "Random"}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5 border-border/50 bg-card/30">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <HardDrive className="size-4" /> Execution
            </h3>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Mode</dt>
                <dd className="font-medium">{job.generationMode}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Workflow</dt>
                <dd className="font-medium">{job.workflowName || "Unknown"}</dd>
              </div>
              <div className="flex justify-between items-start">
                <dt className="text-muted-foreground">Server</dt>
                <dd className="font-medium font-mono text-right">{job.serverName || "Pending"}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5 border-border/50 bg-card/30">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Clock className="size-4" /> Timeline
            </h3>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{format(new Date(job.createdAt), "MMM d, HH:mm:ss")}</dd>
              </div>
              {job.queuedAt && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{format(new Date(job.queuedAt), "HH:mm:ss")}</dd>
                </div>
              )}
              {job.completedAt && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{format(new Date(job.completedAt), "HH:mm:ss")}</dd>
                </div>
              )}
            </dl>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "COMPLETED":
      return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Completed</Badge>;
    case "RUNNING":
    case "DOWNLOADING":
    case "UPLOADING":
      return <Badge className="bg-primary/10 text-primary border-primary/20 animate-pulse">Running</Badge>;
    case "QUEUED":
      return <Badge variant="secondary" className="bg-secondary/50 text-secondary-foreground border-secondary/50">Queued</Badge>;
    case "FAILED":
      return <Badge variant="destructive" className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}