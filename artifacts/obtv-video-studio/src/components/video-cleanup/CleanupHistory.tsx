import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListVideoCleanupJobs, getListVideoCleanupJobsQueryKey, useCancelGeneration } from "@workspace/api-client-react";
import type { VideoCleanupJob } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { sanitizeProviderMessage } from "@/lib/provider-messages";
import { normalizeStatus } from "@/lib/video-cleanup";
import { cleanupErrorMessage as errorMessage } from "./errors";
import { ArrowUpRight, Download, Loader2, X } from "lucide-react";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-secondary text-muted-foreground",
  running: "bg-amber-500/15 text-amber-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-secondary text-muted-foreground",
};

export function CleanupHistory() {
  const queryClient = useQueryClient();
  const { data: jobs, isLoading, isError, refetch } = useListVideoCleanupJobs({
    query: {
      queryKey: getListVideoCleanupJobsQueryKey(),
      refetchInterval: (q) => (q.state.data ?? []).some((j) => ["queued", "running"].includes(normalizeStatus(j.status))) ? 5_000 : 30_000,
    },
  });
  const cancel = useCancelGeneration({
    mutation: { onSettled: () => queryClient.invalidateQueries({ queryKey: getListVideoCleanupJobsQueryKey() }) },
  });
  const [cancelError, setCancelError] = useState("");

  return (
    <section aria-labelledby="history-heading" className="mt-10">
      <h2 id="history-heading" className="mb-4 text-lg font-semibold">Cleanup history</h2>
      {cancelError && <p role="alert" className="mb-3 text-sm text-destructive">{cancelError}</p>}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}</div>
      ) : isError ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm">
          Could not load cleanup jobs. <Button variant="link" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : !jobs?.length ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No cleanup jobs yet. Finished clips show up here with before and after previews.
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {jobs.map((job) => (
            <JobCard key={job.jobId} job={job} cancelling={cancel.isPending && cancel.variables?.id === job.jobId}
              onCancel={() => { setCancelError(""); cancel.mutate({ id: job.jobId }, { onError: (e) => setCancelError(errorMessage(e, "Cancel failed.")) }); }} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobCard({ job, onCancel, cancelling }: { job: VideoCleanupJob; onCancel: () => void; cancelling: boolean }) {
  const status = normalizeStatus(job.status);
  const active = status === "queued" || status === "running";
  const positives = job.points.filter((p) => p.type === "positive").length;
  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card" data-testid={`card-cleanup-${job.jobId}`}>
      <div className="grid grid-cols-2 gap-px bg-border">
        <figure className="bg-card">
          <video src={job.sourceMediaUrl} controls playsInline preload="metadata" className="aspect-video w-full bg-black/60 object-contain" />
          <figcaption className="px-2 py-1 text-[11px] text-muted-foreground">Original</figcaption>
        </figure>
        <figure className="bg-card">
          {job.outputMediaUrl ? (
            <video src={job.outputMediaUrl} controls playsInline preload="metadata" className="aspect-video w-full bg-black/60 object-contain" />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center bg-black/40 text-xs text-muted-foreground">
              {active ? <Loader2 className="size-5 animate-spin" /> : "No output"}
            </div>
          )}
          <figcaption className="px-2 py-1 text-[11px] text-muted-foreground">Cleaned</figcaption>
        </figure>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{job.title}</p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[status]}`} data-testid={`status-cleanup-${job.jobId}`}>{status}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {new Date(job.createdAt).toLocaleString()} · {job.cameraMode} camera · {positives} remove, {job.points.length - positives} protect
        </p>
        {active && job.currentNode && <p className="text-xs text-amber-400" aria-live="polite">{job.currentNode}</p>}
        {job.errorMessage && <p className="text-xs text-destructive">{sanitizeProviderMessage(job.errorMessage)}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {status === "completed" && job.outputMediaUrl && (
            <Button asChild size="sm" variant="secondary">
              <a href={job.outputMediaUrl} download={`cleanup-${job.jobId.slice(0, 8)}.mp4`}><Download className="size-3.5" />Download</a>
            </Button>
          )}
          {active && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelling} data-testid={`button-cancel-${job.jobId}`}>
              {cancelling ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}Cancel
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href={`/generations/${job.jobId}`}>{status === "failed" ? "Details and recovery" : "Details"}<ArrowUpRight className="size-3.5" /></Link>
          </Button>
        </div>
        {status === "failed" && (
          <p className="text-[11px] text-muted-foreground">Failed jobs are never resubmitted automatically. To try again, upload the clip and confirm a new paid job.</p>
        )}
      </div>
    </li>
  );
}
