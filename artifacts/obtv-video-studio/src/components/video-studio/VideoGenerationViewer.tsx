import * as React from "react";
import { getListGenerationsQueryKey, useDeleteGeneration, type GenerationJob } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { generationEditDestination } from "@/lib/generation-edit";
import { sanitizeProviderMessage } from "@/lib/provider-messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Download,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { useLocation, Link } from "wouter";

export interface VideoGenerationViewerProps {
  /** Jobs currently available in the gallery/page, in navigation order. */
  jobs: GenerationJob[];
  /** The opened job ID, or null while the viewer is closed. */
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  onClose: () => void;
}

export function VideoGenerationViewer({
  jobs,
  selectedJobId,
  onSelectJob,
  onClose,
}: VideoGenerationViewerProps) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const deleteGeneration = useDeleteGeneration();
  const selectedIndex = jobs.findIndex((job) => job.id === selectedJobId);
  const job = selectedIndex >= 0 ? jobs[selectedIndex] : null;
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">("idle");
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const isActive = job ? ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status) : false;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < jobs.length - 1;
  const editDestination = job ? generationEditDestination(job) : null;

  const selectRelative = React.useCallback((offset: number) => {
    const nextIndex = selectedIndex + offset;
    if (nextIndex >= 0 && nextIndex < jobs.length) onSelectJob(jobs[nextIndex].id);
  }, [jobs, onSelectJob, selectedIndex]);

  React.useEffect(() => {
    setCopyState("idle");
    setDeleteError(null);
  }, [selectedJobId]);

  React.useEffect(() => {
    if (!job) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest("video, audio, input, textarea, select, [contenteditable], [role='slider']")
      )) return;
      if (event.key === "ArrowLeft" && hasPrevious) {
        event.preventDefault();
        selectRelative(-1);
      } else if (event.key === "ArrowRight" && hasNext) {
        event.preventDefault();
        selectRelative(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasNext, hasPrevious, job, selectRelative]);

  const copyPrompt = async () => {
    if (!job) return;
    try {
      await navigator.clipboard.writeText(job.prompt || "");
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const deleteCurrentGeneration = async () => {
    if (!job || isActive || deleteGeneration.isPending) return;
    if (!window.confirm("Permanently delete this generation and its unreferenced output? This cannot be undone.")) return;
    setDeleteError(null);
    try {
      await deleteGeneration.mutateAsync({ id: job.id });
      onClose();
      await queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete this generation. Please try again.");
    }
  };

  return (
    <Dialog
      open={Boolean(job)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {job && (
        <DialogContent
          className="!max-w-6xl w-[calc(100vw-1rem)] max-h-[94dvh] overflow-y-auto p-0 sm:w-[calc(100vw-2rem)]"
          aria-describedby="video-generation-viewer-description"
          data-testid="dialog-video-generation-viewer"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-4 pr-14 sm:px-6 sm:pr-16">
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg sm:text-xl">
                {job.title || "Untitled generation"}
              </DialogTitle>
              <DialogDescription id="video-generation-viewer-description" className="mt-1">
                {job.status} generation{jobs.length > 1 ? ` · ${selectedIndex + 1} of ${jobs.length}` : ""}
              </DialogDescription>
            </div>
          </div>

          <div className="grid min-w-0 gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
            <div className="min-w-0 space-y-4">
              <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-black">
                {job.status === "COMPLETED" && job.outputUrl ? (
                  <video
                    key={job.id}
                    src={job.outputUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-contain"
                    aria-label={`Generated video: ${job.title || "Untitled generation"}`}
                    data-testid={`video-generation-output-${job.id}`}
                  />
                ) : (
                  <div className="max-w-lg px-5 py-8 text-center">
                    <Badge variant={job.status === "FAILED" ? "destructive" : "secondary"} className="mb-3">
                      {job.status}
                    </Badge>
                    {job.status === "FAILED" ? (
                      <p className="break-words text-sm text-destructive" role="alert" data-testid="text-generation-error">
                        {sanitizeProviderMessage(job.errorMessage, "Generation failed without an error message.")}
                      </p>
                    ) : (
                      <div className="space-y-2 text-sm text-muted-foreground" role="status">
                        <p>{job.status === "QUEUED" ? "This generation is waiting in the queue." : `This generation is ${job.status.toLowerCase()}.`}</p>
                        {job.progress != null && (
                          <p>{Math.round(job.progress * 100)}% complete</p>
                        )}
                        {job.currentNode && <p className="break-words font-mono text-xs">{sanitizeProviderMessage(job.currentNode)}</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <section aria-labelledby="viewer-prompt-heading" className="rounded-lg border border-border/60 bg-card/40 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 id="viewer-prompt-heading" className="text-sm font-semibold">Prompt</h3>
                  <Button variant="outline" size="sm" onClick={copyPrompt} data-testid="button-copy-generation-prompt">
                    <Clipboard className="size-4" />
                    {copyState === "copied" ? "Copied" : "Copy prompt"}
                  </Button>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" data-testid="text-generation-prompt">
                  {job.prompt || "No prompt provided"}
                </p>
                {copyState === "error" && (
                  <p className="mt-2 text-xs text-destructive" role="alert">Could not copy the prompt. Check clipboard permissions and try again.</p>
                )}
              </section>

              {job.compiledPrompt && (
                <details className="rounded-lg border border-border/60 bg-card/30 p-4">
                  <summary className="cursor-pointer text-sm font-medium">Compiled prompt</summary>
                  <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                    {job.compiledPrompt}
                  </p>
                </details>
              )}
            </div>

            <aside className="min-w-0 space-y-4">
              <section className="rounded-lg border border-border/60 bg-card/40 p-4">
                <h3 className="mb-3 text-sm font-semibold">Generation details</h3>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                  <Metadata label="Status" value={job.status} />
                  <Metadata label="Provider" value={job.provider === "FAL" ? "Cloud" : "Local GPU / Comfy"} />
                  <Metadata label="Model" value={job.providerModelId || job.workflowName || "Not specified"} />
                  <Metadata label="Quality" value={job.qualityPreset} />
                  <Metadata label="Resolution" value={`${job.width} × ${job.height}`} />
                  <Metadata label="Duration" value={`${job.durationSeconds} sec`} />
                  <Metadata label="Frame rate" value={`${job.fps} fps`} />
                  <Metadata label="Seed" value={job.seed == null ? "Random" : String(job.seed)} />
                  <Metadata label="Created" value={new Date(job.createdAt).toLocaleString()} />
                  {job.serverName && <Metadata label="Server" value={job.serverName} />}
                  {job.longFormSceneNumber != null && <Metadata label="Scene" value={String(job.longFormSceneNumber)} />}
                  {job.longFormShotNumber != null && <Metadata label="Shot" value={String(job.longFormShotNumber)} />}
                </dl>
              </section>

              <div className="flex flex-wrap gap-2">
                {job.outputUrl && (
                  <>
                    <a
                      href={job.outputUrl}
                      download
                      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="link-download-generation-output"
                    >
                      <Download className="size-4" /> Download
                    </a>
                    <a
                      href={job.outputUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="link-open-generation-output"
                    >
                      <ExternalLink className="size-4" /> Open output
                    </a>
                  </>
                )}
                {editDestination?.kind !== "invalid" && editDestination && job.status !== "RUNNING" && job.status !== "QUEUED" && job.status !== "UPLOADING" && job.status !== "DOWNLOADING" && (
                  <Button
                    variant="outline"
                    onClick={() => setLocation(editDestination.path)}
                    data-testid={editDestination.kind === "long-form" ? "button-edit-long-form-shot" : "button-edit-generation"}
                  >
                    <Pencil className="size-4" />
                    {editDestination.kind === "long-form" ? "Edit shot" : "Edit & Regenerate"}
                  </Button>
                )}
                {!isActive && (
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void deleteCurrentGeneration()}
                    disabled={deleteGeneration.isPending}
                    data-testid="button-delete-generation"
                  >
                    <Trash2 className="size-4" />
                    {deleteGeneration.isPending ? "Deleting..." : "Delete"}
                  </Button>
                )}
              </div>
              {deleteError && <p className="text-xs text-destructive" role="alert">{deleteError}</p>}
              {editDestination?.kind === "invalid" && (
                <p className="text-xs text-destructive" role="alert">{editDestination.reason} Editing is unavailable until the parent shot can be resolved.</p>
              )}

              <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-4">
                <Button variant="outline" size="sm" onClick={() => selectRelative(-1)} disabled={!hasPrevious} aria-label="Previous generation" data-testid="button-previous-generation">
                  <ArrowLeft className="size-4" /> Previous
                </Button>
                <Button variant="outline" size="sm" asChild data-testid="link-generation-full-detail">
                  <Link href={`/generations/${job.id}`}>Full details</Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => selectRelative(1)} disabled={!hasNext} aria-label="Next generation" data-testid="button-next-generation">
                  Next <ArrowRight className="size-4" />
                </Button>
              </div>
              <p className="sr-only" aria-live="polite">Generation {selectedIndex + 1} of {jobs.length}</p>
            </aside>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value}</dd>
    </div>
  );
}

export default VideoGenerationViewer;