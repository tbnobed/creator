import * as React from "react";
import {
  getListGenerationsQueryKey,
  useCancelGeneration,
  useDeleteGeneration,
  useListGenerations,
  type GenerationJob,
} from "@workspace/api-client-react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Activity, ArrowLeft, ArrowRight, Clock, Film, Loader2, Play, Server, Square, Trash2, Video, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDistanceToNow } from "date-fns";
import { Link } from "wouter";
import { VideoGenerationViewer } from "@/components/video-studio/VideoGenerationViewer";

const PAGE_SIZES = ["24", "48", "96"];
const ACTIVE_STATUSES = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];

export default function GenerationsPage() {
  const [page, setPage] = useStateFromUrl("page", 1);
  const [pageSize, setPageSize] = useStateFromUrl("pageSize", 24);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const listQueryKey = getListGenerationsQueryKey({ page, pageSize });
  const { data, isLoading, isFetching, isPlaceholderData } = useListGenerations(
    { page, pageSize },
    { query: {
      queryKey: listQueryKey,
      placeholderData: keepPreviousData,
      refetchInterval: (query) => query.state.data?.items.some(
        (job) => ACTIVE_STATUSES.includes(job.status),
      ) ? 5_000 : 30_000,
    } },
  );
  const cancelJob = useCancelGeneration({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() }),
    },
  });
  const deleteJob = useDeleteGeneration({
    mutation: {
      onSuccess: () => {
        if (page > 1 && data && data.items.length === 1) setPage(page - 1);
        void queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() });
      },
    },
  });

  const jobs = data?.items ?? [];
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.includes(job.status));
  const historyJobs = jobs.filter((job) => !ACTIVE_STATUSES.includes(job.status));
  const requestCancellation = (jobId: string) => {
    if (window.confirm("Cancel this generation? The current ComfyUI prompt will be interrupted and cannot be resumed.")) {
      cancelJob.mutate({ id: jobId });
    }
  };
  const requestDeletion = (jobId: string) => {
    if (window.confirm("Delete this generation from queue history? Active generations must be cancelled first.")) {
      deleteJob.mutate({ id: jobId });
    }
  };
  const totalPages = data?.totalPages ?? 1;
  const start = data && data.totalItems > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = data ? Math.min(data.page * data.pageSize, data.totalItems) : 0;
  React.useEffect(() => {
    if (data && !isPlaceholderData && data.page !== page) setPage(data.page);
  }, [data?.page, isPlaceholderData, page]);

  return (
    <Page className="max-w-7xl mx-auto p-4 md:p-8 bg-background min-h-[100dvh]">
      <div className="flex items-center gap-3 border-b border-border/50 pb-4 mb-6">
        <div className="size-10 bg-primary/20 rounded-md flex items-center justify-center">
          <Activity className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Production Queue</h1>
          <p className="text-muted-foreground text-xs font-medium">Monitor active rendering jobs and historical output.</p>
        </div>
      </div>

      {isLoading ? (
        <LoadingGrid />
      ) : data?.totalItems === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="space-y-7">
            <SummaryStrip data={data!} activeCount={activeJobs.length} historyCount={historyJobs.length} />
            <JobSection
              title="Active queue"
              icon={<Activity className="size-4 text-primary" />}
              description={`${activeJobs.length} active on this page`}
              jobs={activeJobs}
              onOpen={setSelectedJobId}
              emptyLabel="No active jobs on this page"
              onCancel={requestCancellation}
              onDelete={requestDeletion}
              cancelPending={cancelJob.isPending}
              deletePending={deleteJob.isPending}
            />
            <HistorySection
              title="History"
              icon={<Film className="size-4 text-muted-foreground" />}
              description={`${historyJobs.length} completed or archived on this page`}
              jobs={historyJobs}
              onOpen={setSelectedJobId}
              emptyLabel="No history on this page"
              onCancel={requestCancellation}
              onDelete={requestDeletion}
              cancelPending={cancelJob.isPending}
              deletePending={deleteJob.isPending}
            />
          </div>
          <Pagination
            page={data?.page ?? page}
            totalPages={totalPages}
            pageSize={data?.pageSize ?? pageSize}
            start={start}
            end={end}
            totalItems={data?.totalItems ?? 0}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
          />
        </>
      )}
      <VideoGenerationViewer
        jobs={jobs}
        selectedJobId={selectedJobId}
        onSelectJob={setSelectedJobId}
        onClose={() => setSelectedJobId(null)}
      />
    </Page>
  );
}

function useStateFromUrl(key: string, fallback: number): [number, (value: number) => void] {
  const [value, setValue] = React.useState(() => {
    const parsed = Number(new URLSearchParams(window.location.search).get(key));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  });
  const update = (next: number) => {
    setValue(next);
    const params = new URLSearchParams(window.location.search);
    if (next === fallback) params.delete(key);
    else params.set(key, String(next));
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  };
  return [value, update];
}

function SummaryStrip({ data, activeCount, historyCount }: { data: { totalItems: number; totalPages: number; page: number; pageSize: number }; activeCount: number; historyCount: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
      <Card className="border-primary/20 bg-primary/[0.04] p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><Activity className="size-5" /></div>
          <div className="min-w-28"><p className="text-sm font-semibold">Studio pulse</p><p className="text-xs text-muted-foreground">Page {data.page} of {data.totalPages}</p></div>
          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="On page" value={activeCount + historyCount} />
            <Metric label="All time" value={data.totalItems} />
            <Metric label="Active" value={activeCount} accent />
            <Metric label="History" value={historyCount} />
          </div>
        </div>
      </Card>
      <Card className="flex items-center p-4">
        <div className="w-full">
          <div className="mb-3 flex items-center gap-2"><Server className="size-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Queue overview</h2></div>
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>{data.pageSize} per page</span>
            <Badge variant="outline" className="h-5 text-[10px]">Newest first</Badge>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <div className="rounded-lg border border-border/60 bg-background/30 p-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className={`mt-1 text-xl font-semibold ${accent ? "text-primary" : ""}`}>{value}</p></div>;
}

function JobSection({ title, icon, description, jobs, emptyLabel, onOpen, onCancel, onDelete, cancelPending, deletePending }: { title: string; icon: React.ReactNode; description: string; jobs: GenerationJob[]; emptyLabel: string; onOpen: (id: string) => void; onCancel: (id: string) => void; onDelete: (id: string) => void; cancelPending: boolean; deletePending: boolean }) {
  return (
    <section className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {jobs.length === 0 ? <Card className="flex min-h-36 col-span-full items-center justify-center border-dashed bg-card/20 p-5 text-center text-xs text-muted-foreground">{emptyLabel}</Card> : jobs.map((job) => <GenerationCard key={job.id} job={job} onOpen={onOpen} onCancel={onCancel} onDelete={onDelete} cancelPending={cancelPending} deletePending={deletePending} />)}
      </div>
    </section>
  );
}

function HistorySection({ title, icon, description, jobs, emptyLabel, onOpen, onCancel, onDelete, cancelPending, deletePending }: { title: string; icon: React.ReactNode; description: string; jobs: GenerationJob[]; emptyLabel: string; onOpen: (id: string) => void; onCancel: (id: string) => void; onDelete: (id: string) => void; cancelPending: boolean; deletePending: boolean }) {
  const groups = groupHistoryJobs(jobs);
  return (
    <section className="min-w-0">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {groups.length === 0 ? (
        <Card className="flex min-h-36 items-center justify-center border-dashed bg-card/20 p-5 text-center text-xs text-muted-foreground">{emptyLabel}</Card>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.key} className="space-y-4">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/50 pb-2">
                <Film className="size-4 shrink-0 text-primary" />
                {group.projectId ? (
                  <Link href={`/projects/${group.projectId}`} className="truncate text-sm font-semibold text-foreground hover:text-primary transition-colors">
                    {group.label}
                  </Link>
                ) : (
                  <span className="truncate text-sm font-semibold text-foreground">{group.label}</span>
                )}
                <Badge variant="outline" className="ml-auto h-5 shrink-0 px-2 text-[10px] font-mono">{group.jobs.length}</Badge>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {group.jobs.map((job) => (
                  <GenerationCard key={job.id} job={job} onOpen={onOpen} onCancel={onCancel} onDelete={onDelete} cancelPending={cancelPending} deletePending={deletePending} compact />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function groupHistoryJobs(jobs: GenerationJob[]) {
  const groups = new Map<string, { key: string; label: string; projectId: string | null; jobs: GenerationJob[] }>();
  for (const job of jobs) {
    const key = job.longFormProjectId ? `project:${job.longFormProjectId}` : "standalone";
    const existing = groups.get(key);
    if (existing) {
      existing.jobs.push(job);
    } else {
      groups.set(key, {
        key,
        label: job.longFormProjectTitle || "Standalone generations",
        projectId: job.longFormProjectId ?? null,
        jobs: [job],
      });
    }
  }
  return Array.from(groups.values());
}

function GenerationCard({ job, onOpen, onCancel, onDelete, cancelPending, deletePending, compact = false }: { job: GenerationJob; onOpen: (id: string) => void; onCancel: (id: string) => void; onDelete: (id: string) => void; cancelPending: boolean; deletePending: boolean; compact?: boolean }) {
  const isCancellable = ACTIVE_STATUSES.includes(job.status);
  const executionLabel = job.provider === "FAL"
    ? formatProviderModel(job.providerModelId)
    : "Local GPU / Comfy";
  const poster = job.status === "COMPLETED" && job.outputUrl ? job.outputUrl : null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-secondary/30 aspect-[4/3] group transition-all hover:border-primary/50 hover:shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
      {poster ? (
        <video
          src={poster}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          muted loop playsInline
          onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
          onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
        />
      ) : (
        <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-muted-foreground bg-secondary/10">
          {job.status === "RUNNING" ? <Loader2 className="size-8 animate-spin text-primary mb-2" /> : job.status === "FAILED" ? <XCircle className="size-8 text-destructive mb-2" /> : job.status === "QUEUED" ? <Clock className="size-8 mb-2" /> : <Film className="size-8 mb-2 opacity-50" />}
          <StatusBadge status={job.status} />
        </div>
      )}

      {/* Dark gradient overlay for text readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/10 pointer-events-none opacity-80 group-hover:opacity-100 transition-opacity" />

      {/* Top right actions */}
      <div className="absolute top-2 right-2 flex items-center gap-1 z-10 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 [@media(hover:none)]:!opacity-100">
        {isCancellable ? (
          <Button variant="secondary" size="icon" className="size-7 h-7 shrink-0 text-destructive bg-black/50 hover:bg-destructive/20 border border-destructive/30" onClick={(e) => { e.preventDefault(); onCancel(job.id); }} disabled={cancelPending} title="Cancel" aria-label={`Cancel ${job.title || "generation"}`}>
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button variant="secondary" size="icon" className="size-7 h-7 shrink-0 text-muted-foreground bg-black/50 hover:bg-destructive/20 hover:text-destructive border border-border/50 hover:border-destructive/30" onClick={(e) => { e.preventDefault(); onDelete(job.id); }} disabled={deletePending} title="Delete" aria-label={`Delete ${job.title || "generation"}`}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      <button
        type="button"
        className="absolute inset-0 z-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={() => onOpen(job.id)}
        aria-label={`Open video viewer for ${job.title || "Untitled Job"}`}
        data-testid={`button-open-generation-${job.id}`}
      />

      <div className="absolute bottom-0 left-0 right-0 p-3 z-10 pointer-events-none">
        <p className="text-xs font-medium text-white line-clamp-2 leading-snug mb-1 drop-shadow-md">
          {job.prompt || "No prompt provided"}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[9px] text-white/70">
          <span className="flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded border border-white/10 backdrop-blur-sm">
            <Server className="size-2.5" /> {executionLabel}
          </span>
          <span className="bg-black/40 px-1.5 py-0.5 rounded border border-white/10 backdrop-blur-sm">
            {formatDistanceToNow(new Date(job.createdAt))} ago
          </span>
        </div>
      </div>
    </div>
  );
}

function formatProviderModel(providerModelId: string | null) {
  switch (providerModelId) {
    case "fal-ai/veo3.1/fast": return "Cloud · Veo 3.1 Fast";
    case "fal-ai/kling-video/v3/standard/text-to-video": return "Cloud · Kling v3 Standard";
    case "bytedance/seedance-2.0/enterprise/mini/text-to-video": return "Cloud · Seedance 2.0 Mini";
    case "bytedance/seedance-2.0/enterprise/v2/text-to-video": return "Cloud · Seedance 2.0 quality";
    default: return providerModelId ? "Cloud · Custom model" : "Cloud";
  }
}

function Pagination({ page, totalPages, pageSize, start, end, totalItems, onPageChange, onPageSizeChange }: { page: number; totalPages: number; pageSize: number; start: number; end: number; totalItems: number; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void }) {
  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">{start}–{end} of {totalItems} generations</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}><SelectTrigger className="h-8 w-[112px] text-xs"><SelectValue /></SelectTrigger><SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={size} className="text-xs">{size} per page</SelectItem>)}</SelectContent></Select>
        <Button variant="outline" size="sm" className="h-8" onClick={() => onPageChange(page - 1)} disabled={page <= 1}><ArrowLeft className="mr-1.5 size-3.5" />Previous</Button>
        <span className="min-w-16 text-center text-xs text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="outline" size="sm" className="h-8" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>Next<ArrowRight className="ml-1.5 size-3.5" /></Button>
      </div>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((item) => (
        <Card key={item} className="aspect-[4/3] animate-pulse border-border/50 bg-secondary/20 rounded-xl" />
      ))}
    </div>
  );
}

function EmptyState() {
  return <div className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-dashed border-border/50 bg-card/10 px-4 text-center"><div className="mb-4 flex size-16 items-center justify-center rounded-full bg-secondary/50"><Activity className="size-8 text-muted-foreground" /></div><h3 className="mb-2 text-lg font-semibold">No generations yet</h3><p className="mb-6 max-w-md text-sm text-muted-foreground">Head over to the Generate tab to start producing video.</p><Link href="/" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Start Generating</Link></div>;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "COMPLETED": return <Badge className="h-5 border-emerald-500/20 bg-emerald-500/10 px-2 text-[10px] text-emerald-500">Completed</Badge>;
    case "RUNNING": case "DOWNLOADING": case "UPLOADING": return <Badge className="h-5 border-primary/20 bg-primary/10 px-2 text-[10px] text-primary">Running</Badge>;
    case "QUEUED": return <Badge variant="secondary" className="h-5 px-2 text-[10px]">Queued</Badge>;
    case "FAILED": return <Badge variant="destructive" className="h-5 px-2 text-[10px]">Failed</Badge>;
    case "CANCELLED": return <Badge variant="outline" className="h-5 px-2 text-[10px]">Cancelled</Badge>;
    default: return <Badge variant="outline" className="h-5 px-2 text-[10px]">{status}</Badge>;
  }
}