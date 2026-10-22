import { GenerationDetails, GenerationPlayer, GenerationPrompt } from "@/components/video-studio/GenerationMedia";
import { ErrorNotice } from "@/components/shared/error-notice";
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
import { sanitizeProviderMessage } from "@/lib/provider-messages";
import { generationEditDestination } from "@/lib/generation-edit";
import { isTopazVideo, TopazProvenance, TopazUpscaleAction } from "@/components/video-studio/TopazUpscaleAction";

export default function GenerationDetailPage() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = params.id as string;
  const { data: job, isLoading, isError, refetch, isFetching } = useGetGeneration(id, {
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
          <Button asChild variant="ghost" size="icon"><Link href="/generations" aria-label="Back to Queue &amp; History" data-testid="link-back-queue"><ArrowLeft className="size-4" /></Link></Button>
          <div className="h-8 w-64 bg-card animate-pulse rounded" />
        </div>
        <div className="h-[400px] w-full bg-card animate-pulse rounded-lg" />
      </Page>
    );
  }

  if (!job) {
    return (
      <Page>
        <Button asChild variant="ghost" size="sm" className="mb-4 gap-2"><Link href="/generations" data-testid="link-back-queue"><ArrowLeft className="size-4" /> Queue &amp; History</Link></Button>
        {isError
          ? <ErrorNotice testId="status-generation-error" title="Could not load this generation" message="It may have been deleted, or the connection failed." onRetry={() => void refetch()} retrying={isFetching} />
          : <ErrorNotice testId="status-generation-missing" title="Generation not found" message="It may have been deleted or belong to another workspace." />}
      </Page>
    );
  }

  const isRunning = ["RUNNING", "QUEUED", "UPLOADING", "DOWNLOADING"].includes(job.status);
  const isFailed = job.status === "FAILED";
  const isCompleted = job.status === "COMPLETED";
  const editDestination = generationEditDestination(job);

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <Button asChild variant="ghost" size="icon"><Link href="/generations" aria-label="Back to Queue &amp; History" data-testid="link-back-queue"><ArrowLeft className="size-4" /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            {job.title || "Untitled Job"}
            <StatusBadge status={job.status} />
          </h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">ID: {job.id}</p>
        </div>
        <TopazUpscaleAction key={job.id} job={job} />
        {!isTopazVideo(job) && !isRunning && editDestination.kind !== "invalid" && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setLocation(editDestination.path)}
            data-testid={editDestination.kind === "long-form" ? "button-edit-long-form-shot" : "button-edit-generation"}
          >
            <Pencil className="size-4" />
            {editDestination.kind === "long-form" ? "Edit shot" : "Edit & Regenerate"}
          </Button>
        )}
      </div>
      {editDestination.kind === "invalid" && (
        <div className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert" data-testid="alert-generation-edit-link">
          {editDestination.reason} Editing is unavailable until the parent shot can be resolved.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <TopazProvenance job={job} />
          {isCompleted && job.outputUrl && <a className="inline-block text-sm text-primary underline" href={job.outputUrl} download>Download video</a>}
          {/* Main Display Area */}
          <GenerationPlayer job={job} pending={<div className="flex h-full w-full flex-col items-center justify-center">{isRunning ? (
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
                      <p className="text-xs font-mono text-muted-foreground mt-2">Node: {sanitizeProviderMessage(job.currentNode)}</p>
                    )}
                  </div>
                </div>
              ) : isFailed ? (
                <div className="flex flex-col items-center justify-center text-destructive gap-4 p-8 text-center">
                  <AlertTriangle className="size-12" />
                  <div>
                    <p className="font-bold text-lg mb-1">Generation Failed</p>
                    <p className="text-sm font-mono bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md max-w-lg">
                      {sanitizeProviderMessage(job.errorMessage, "Unknown error occurred")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-muted-foreground gap-4">
                  <PlayCircle className="size-12 opacity-50" />
                  <p>Job is {job.status.toLowerCase()}</p>
                </div>
              )}</div>} />

          <GenerationPrompt prompt={job.prompt} compiledPrompt={job.compiledPrompt} />
        </div>

        <div className="space-y-6">
          <GenerationDetails job={job} title="Job details" />
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