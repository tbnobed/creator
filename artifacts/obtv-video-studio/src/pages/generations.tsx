import { getListGenerationsQueryKey, useCancelGeneration, useListGenerations } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Activity, Play, CheckCircle2, XCircle, Clock, Loader2, Video, Square } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { Link } from "wouter";

export default function GenerationsPage() {
  const { data: generations, isLoading } = useListGenerations();
  const queryClient = useQueryClient();
  const cancelJob = useCancelGeneration({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() }),
    },
  });

  const requestCancellation = (jobId: string) => {
    if (window.confirm("Cancel this generation? The current ComfyUI prompt will be interrupted and cannot be resumed.")) {
      cancelJob.mutate({ id: jobId });
    }
  };

  return (
    <Page>
      <PageHeader 
        title="Production Queue" 
        description="Monitor active rendering jobs and historical output."
      />

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-24 bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : generations?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Activity className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">No generations yet</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Head over to the Generate tab to start producing video.
          </p>
          <Link href="/" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
            Start Generating
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {generations?.map(job => {
            const isCancellable = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status);
            return (
              <Card key={job.id} className="p-4 hover:border-primary/50 transition-colors bg-card/30 backdrop-blur-sm group border-border/50 flex items-center gap-4">
                <Link href={`/generations/${job.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                <div className="size-12 rounded bg-secondary/50 flex flex-shrink-0 items-center justify-center overflow-hidden">
                  {job.status === "COMPLETED" && job.outputUrl ? (
                    <Video className="size-5 text-primary" />
                  ) : job.status === "RUNNING" ? (
                    <Loader2 className="size-5 text-primary animate-spin" />
                  ) : job.status === "FAILED" ? (
                    <XCircle className="size-5 text-destructive" />
                  ) : job.status === "QUEUED" ? (
                    <Clock className="size-5 text-muted-foreground" />
                  ) : (
                    <Play className="size-5 text-muted-foreground" />
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold truncate group-hover:text-primary transition-colors">{job.title || "Untitled Job"}</h3>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="truncate max-w-[200px] sm:max-w-[400px]">Prompt: {job.prompt}</span>
                    <span className="hidden sm:inline-block">Mode: {job.generationMode}</span>
                  </div>
                </div>

                <div className="hidden md:flex flex-col items-end gap-1 flex-shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                  </span>
                  {job.serverName && (
                    <Badge variant="outline" className="text-[10px] font-mono bg-background/50 h-5 px-1.5">{job.serverName}</Badge>
                  )}
                </div>
                </Link>
                {isCancellable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => requestCancellation(job.id)}
                    disabled={cancelJob.isPending}
                    title="Cancel this generation"
                  >
                    <Square className="mr-1.5 size-3.5 fill-current" />
                    Cancel
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "COMPLETED":
      return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20">Completed</Badge>;
    case "RUNNING":
    case "DOWNLOADING":
    case "UPLOADING":
      return <Badge className="bg-primary/10 text-primary border-primary/20 hover:bg-primary/20">Running</Badge>;
    case "QUEUED":
      return <Badge variant="secondary" className="bg-secondary/50 text-secondary-foreground border-secondary/50">Queued</Badge>;
    case "FAILED":
      return <Badge variant="destructive" className="bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}