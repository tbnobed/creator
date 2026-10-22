import { Link } from "wouter";
import { Clapperboard, Eraser, Film, Palette, Shirt } from "lucide-react";
import { useListGarmentJobs, useListImageStudioJobs, useListProductionProjects } from "@workspace/api-client-react";
import { CleanupHistory } from "@/components/video-cleanup/CleanupHistory";
import { normalizeState, STEPS } from "@/lib/production-types";
import { ToolJobList } from "./ToolJobList";

export type HistoryTool = "video" | "image" | "cleanup" | "replacement" | "longform";
export const HISTORY_TOOLS: { id: HistoryTool; label: string; icon: typeof Film; href: string }[] = [
  { id: "video", label: "Generate Video", icon: Clapperboard, href: "/studio" },
  { id: "image", label: "Image Studio", icon: Palette, href: "/image-studio" },
  { id: "cleanup", label: "Video Cleanup", icon: Eraser, href: "/video-cleanup" },
  { id: "replacement", label: "Video Replacement", icon: Shirt, href: "/garment-studio" },
  { id: "longform", label: "Long-Form", icon: Film, href: "/projects" },
];

export function readHistoryTool(): HistoryTool {
  const t = new URLSearchParams(window.location.search).get("tool");
  return HISTORY_TOOLS.some((x) => x.id === t) ? (t as HistoryTool) : "video";
}

export function ToolTabs({ tool, onChange }: { tool: HistoryTool; onChange: (t: HistoryTool) => void }) {
  return (
    <div role="tablist" aria-label="Tool" className="mb-6 flex gap-1 overflow-x-auto rounded-lg border border-border/60 bg-card/30 p-1" data-testid="tabs-history-tool">
      {HISTORY_TOOLS.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" role="tab" aria-selected={tool === id} onClick={() => onChange(id)}
          className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tool === id ? "bg-primary/20 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          data-testid={`tab-tool-${id}`}>
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
}

const Open = ({ href, label }: { href: string; label: string }) => (
  <Link href={href} className="mt-3 inline-block text-xs font-medium text-primary hover:underline" data-testid="link-open-tool">Open {label}</Link>
);

function ImageHistory() {
  const q = useListImageStudioJobs({ limit: 50 });
  const rows = (q.data?.jobs ?? []).map((j) => ({
    id: j.id, title: j.prompt || "Untitled image", subtitle: `${j.modelName} / ${j.provider === "CLOUD" ? "Paid cloud" : "Local"} / ${j.count} image${j.count === 1 ? "" : "s"}`,
    status: j.status, createdAt: j.createdAt, thumbUrl: j.assets?.[0]?.url, href: "/image-studio", error: j.errorMessage,
  }));
  return <ToolJobList testId="list-image-jobs" rows={rows} isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} empty="No Image Studio jobs yet." footer={<Open href="/image-studio" label="Image Studio" />} />;
}

function ReplacementHistory() {
  const q = useListGarmentJobs();
  const rows = (q.data ?? []).map((j) => ({
    id: j.id, title: j.title, subtitle: `${j.mode === "animate-artwork" ? "Animate artwork" : "Replace target"} / ${j.provider === "FAL" ? "Paid cloud" : "Local"}`,
    status: j.status, createdAt: j.createdAt, href: "/garment-studio", error: j.error,
  }));
  return <ToolJobList testId="list-replacement-jobs" rows={rows} isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} empty="No replacement jobs yet." footer={<Open href="/garment-studio" label="Video Replacement" />} />;
}

function LongFormHistory() {
  const q = useListProductionProjects();
  const rows = (q.data ?? []).map((p) => {
    const st = normalizeState(p.state as Record<string, unknown>);
    return { id: p.id, title: p.title, subtitle: `Step ${st.step + 1} · ${STEPS[st.step]} · ${st.story.scenes.length} scenes`, status: st.tasks.some((t) => ["QUEUED", "RUNNING"].includes(t.status.toUpperCase())) ? "RUNNING" : "DRAFT", createdAt: p.updatedAt, href: `/productions/${p.id}` };
  });
  return <ToolJobList testId="list-productions" rows={rows} isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} empty="No productions yet." footer={<Open href="/projects" label="Long-Form" />} />;
}

/** Embedded history for non-video tools. Video history stays the page's own queue/library. */
export function ToolHistory({ tool }: { tool: Exclude<HistoryTool, "video"> }) {
  if (tool === "image") return <ImageHistory />;
  if (tool === "cleanup") return <div><CleanupHistory /><Open href="/video-cleanup" label="Video Cleanup" /></div>;
  if (tool === "replacement") return <ReplacementHistory />;
  return <LongFormHistory />;
}
