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

const PAGE_SIZES = ["6", "12", "24", "48"];
const ACTIVE_STATUSES = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];

export default function GenerationsPage() {
  const [page, setPage] = useStateFromUrl("page", 1);
  const [pageSize, setPageSize] = useStateFromUrl("pageSize", 12);
  const queryClient = useQueryClient();
  const listQueryKey = getListGenerationsQueryKey({ page, pageSize });
  const { data, isLoading, isFetching, isPlaceholderData } = useListGenerations(
    { page, pageSize },
    { query: { queryKey: listQueryKey, placeholderData: keepPreviousData } },
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
    <Page>
      <PageHeader
        title="Production Queue"
        description="Monitor active rendering jobs and historical output."
        actions={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {isFetching && <Loader2 className="size-3.5 animate-spin text-primary" />}
            <span>{data?.totalItems ?? 0} total generations</span>
          </div>
        }
      />

      {isLoading ? (
        <LoadingGrid />
      ) : data?.totalItems === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(210px,0.8fr)_minmax(280px,1.15fr)_minmax(320px,1.7fr)]">
            <SummaryColumn data={data!} activeCount={activeJobs.length} historyCount={historyJobs.length} />
            <JobColumn
              title="Active queue"
              icon={<Activity className="size-4 text-primary" />}
              description={`${activeJobs.length} active on this page`}
              jobs={activeJobs}
              emptyLabel="No active jobs on this page"
              onCancel={requestCancellation}
              onDelete={requestDeletion}
              cancelPending={cancelJob.isPending}
              deletePending={deleteJob.isPending}
            />
            <JobColumn
              title="History"
              icon={<Film className="size-4 text-muted-foreground" />}
              description={`${historyJobs.length} completed or archived on this page`}
              jobs={historyJobs}
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

function SummaryColumn({ data, activeCount, historyCount }: { data: { totalItems: number; totalPages: number; page: number; pageSize: number }; activeCount: number; historyCount: number }) {
  return (
    <div className="space-y-4 xl:sticky xl:top-5">
      <Card className="border-primary/20 bg-primary/[0.04] p-5">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary"><Activity className="size-5" /></div>
          <div><p className="text-sm font-semibold">Studio pulse</p><p className="text-xs text-muted-foreground">Page {data.page} of {data.totalPages}</p></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="On page" value={activeCount + historyCount} />
          <Metric label="All time" value={data.totalItems} />
          <Metric label="Active" value={activeCount} accent />
          <Metric label="History" value={historyCount} />
        </div>
      </Card>
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2"><Server className="size-4 text-muted-foreground" /><h2 className="text-sm font-semibold">Queue overview</h2></div>
        <div className="space-y-3 text-xs text-muted-foreground">
          <div className="flex items-center justify-between"><span>Items per page</span><span className="font-medium text-foreground">{data.pageSize}</span></div>
          <div className="flex items-center justify-between"><span>Newest first</span><Badge variant="outline" className="h-5 text-[10px]">Live order</Badge></div>
          <p className="border-t border-border/60 pt-3 leading-relaxed">Generations are ordered newest first. Use the page controls below to move through older renders.</p>
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <div className="rounded-lg border border-border/60 bg-background/30 p-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className={`mt-1 text-xl font-semibold ${accent ? "text-primary" : ""}`}>{value}</p></div>;
}

function JobColumn({ title, icon, description, jobs, emptyLabel, onCancel, onDelete, cancelPending, deletePending }: { title: string; icon: React.ReactNode; description: string; jobs: GenerationJob[]; emptyLabel: string; onCancel: (id: string) => void; onDelete: (id: string) => void; cancelPending: boolean; deletePending: boolean }) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
      </div>
      <div className="space-y-3">
        {jobs.length === 0 ? <Card className="flex min-h-36 items-center justify-center border-dashed bg-card/20 p-5 text-center text-xs text-muted-foreground">{emptyLabel}</Card> : jobs.map((job) => <GenerationCard key={job.id} job={job} onCancel={onCancel} onDelete={onDelete} cancelPending={cancelPending} deletePending={deletePending} />)}
      </div>
    </section>
  );
}

function GenerationCard({ job, onCancel, onDelete, cancelPending, deletePending }: { job: GenerationJob; onCancel: (id: string) => void; onDelete: (id: string) => void; cancelPending: boolean; deletePending: boolean }) {
  const isCancellable = ACTIVE_STATUSES.includes(job.status);
  return (
    <Card className="group relative flex min-w-0 flex-col gap-3 border-border/60 bg-card/40 p-4 transition-colors hover:border-primary/45">
      <Link href={`/generations/${job.id}`} className="min-w-0">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary/60">{job.status === "COMPLETED" && job.outputUrl ? <Video className="size-5 text-primary" /> : job.status === "RUNNING" ? <Loader2 className="size-5 animate-spin text-primary" /> : job.status === "FAILED" ? <XCircle className="size-5 text-destructive" /> : job.status === "QUEUED" ? <Clock className="size-5 text-muted-foreground" /> : <Play className="size-5 text-muted-foreground" />}</div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold group-hover:text-primary">{job.title || "Untitled Job"}</h3><StatusBadge status={job.status} /></div>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{job.prompt}</p>
          </div>
        </div>
      </Link>
      <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3 text-[10px] text-muted-foreground">
        <span>{formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}</span>
        {job.serverName && <Badge variant="outline" className="max-w-[45%] truncate bg-background/50 text-[9px] font-mono">{job.serverName}</Badge>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] text-muted-foreground">{job.generationMode} · {job.width}×{job.height}</span>
        {isCancellable ? <Button variant="outline" size="sm" className="h-7 shrink-0 border-destructive/40 px-2 text-[10px] text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onCancel(job.id)} disabled={cancelPending}><Square className="mr-1 size-3 fill-current" />Cancel</Button> : <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(job.id)} disabled={deletePending} title="Delete from queue history" aria-label="Delete from queue history"><Trash2 className="size-3.5" /></Button>}
      </div>
    </Card>
  );
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
  return <div className="grid gap-4 xl:grid-cols-3">{[1, 2, 3].map((column) => <div key={column} className="space-y-3">{[1, 2, 3].map((item) => <Card key={item} className="h-36 animate-pulse border-border/50 bg-card/50" />)}</div>)}</div>;
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