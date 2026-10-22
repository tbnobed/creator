import * as React from "react";
import { type GenerationJob, useCancelGeneration } from "@workspace/api-client-react";
import { useUndoableVideoDelete } from "@/components/video-studio/UndoableDelete";
import { generationEditDestination } from "@/lib/generation-edit";
import { GenerationDetails, GenerationPlayer, GenerationPrompt } from "./GenerationMedia";
import { sanitizeProviderMessage } from "@/lib/provider-messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { isTopazVideo, TopazProvenance, TopazUpscaleAction } from "./TopazUpscaleAction";
import {
  ArrowLeft,
  ArrowRight,
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
  const undoableDelete = useUndoableVideoDelete();
  const cancel = useCancelGeneration();
  const selectedIndex = jobs.findIndex((job) => job.id === selectedJobId);
  const job = selectedIndex >= 0 ? jobs[selectedIndex] : null;
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const isActive = job ? ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status) : false;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < jobs.length - 1;
  const editDestination = job ? generationEditDestination(job) : null;

  const selectRelative = React.useCallback((offset: number) => {
    const nextIndex = selectedIndex + offset;
    if (nextIndex >= 0 && nextIndex < jobs.length) onSelectJob(jobs[nextIndex].id);
  }, [jobs, onSelectJob, selectedIndex]);

  React.useEffect(() => {
    cancel.reset();
    setDeleteError(null);
    setConfirmDelete(false);
  }, [selectedJobId]);

  React.useEffect(() => {
    if (!job) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector("[data-topaz-dialog]")) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable ||
        target.closest("input, textarea, select, [contenteditable], [role='slider']")
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


  const deleteCurrentGeneration = async () => {
    // Active jobs stay guarded here and server-side (409); finished jobs soft-delete with undo.
    if (!job || isActive || undoableDelete.pending) return;
    setDeleteError(null);
    if (await undoableDelete.deleteVideos([job.id])) onClose();
  };

  return (
    <>
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
                {job.status.charAt(0) + job.status.slice(1).toLowerCase()} generation{jobs.length > 1 ? ` · ${selectedIndex + 1} of ${jobs.length} in this view` : ""}
              </DialogDescription>
            </div>
          </div>

          <div className="grid min-w-0 gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
            <div className="min-w-0 space-y-4">
              <GenerationPlayer job={job} pending={
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
                        {job.status === "RUNNING" && job.progress != null && (
                          <p>{Math.round(job.progress * 100)}% of current processing stage</p>
                        )}
                        <p>Queue position and completion estimate are not available.</p>
                        {isActive && <Button variant="outline" disabled={cancel.isPending || cancel.isSuccess} onClick={() => cancel.mutate({ id: job.id })}>{cancel.isSuccess ? "Cancellation requested" : cancel.isPending ? "Cancelling…" : "Cancel render"}</Button>}
                        {cancel.isError && <p role="alert">Could not cancel this render. Please try again.</p>}
                      </div>
                    )}
                  </div>
              } />
              <GenerationPrompt key={job.id} prompt={job.prompt} compiledPrompt={job.compiledPrompt} />
            </div>

            <aside className="min-w-0 space-y-4">
              <TopazProvenance job={job} />
              <GenerationDetails job={job} />

              <div className="flex flex-wrap gap-2">
                <TopazUpscaleAction key={job.id} job={job} />
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
                {!isTopazVideo(job) && editDestination?.kind !== "invalid" && editDestination && job.status !== "RUNNING" && job.status !== "QUEUED" && job.status !== "UPLOADING" && job.status !== "DOWNLOADING" && (
                  <Button
                    variant="outline"
                    onClick={() => { onClose(); setLocation(editDestination.path); }}
                    data-testid={editDestination.kind === "long-form" ? "button-edit-long-form-shot" : "button-edit-generation"}
                  >
                    <Pencil className="size-4" />
                    {editDestination.kind === "long-form" ? "Edit shot" : "Edit & Regenerate"}
                  </Button>
                )}
              </div>
              {!isActive && <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">{confirmDelete ? "Delete this generation? You can undo immediately afterward." : "Delete requires confirmation."}</p>
                {confirmDelete && <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep generation</Button>}
                {!isActive && (
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => confirmDelete ? void deleteCurrentGeneration() : setConfirmDelete(true)}
                    disabled={undoableDelete.pending}
                    data-testid="button-delete-generation"
                  >
                    <Trash2 className="size-4" />
                    {undoableDelete.pending ? "Deleting..." : confirmDelete ? "Confirm delete" : "Delete…"}
                  </Button>
                )}
              </div>}
              {(deleteError || undoableDelete.error) && <p className="text-xs text-destructive" role="alert">{deleteError || undoableDelete.error}</p>}
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
    {undoableDelete.toast}
    </>
  );
}
