import type { ReactNode } from "react";
import { Link } from "wouter";
import { ErrorNotice } from "@/components/shared/error-notice";

export interface ToolJobRow { id: string; title: string; subtitle?: string; status: string; createdAt?: string; thumbUrl?: string | null; href: string; error?: string | null }

const tone = (s: string) => {
  const u = s.toUpperCase();
  if (["COMPLETED", "SUCCEEDED", "READY"].includes(u)) return "bg-emerald-500/15 text-emerald-400";
  if (["FAILED", "ERROR"].includes(u)) return "bg-destructive/15 text-destructive";
  if (["CANCELLED", "CANCELED"].includes(u)) return "bg-muted text-muted-foreground";
  return "bg-primary/15 text-primary";
};

/** Reusable history list for tool jobs shown inside Queue & History. Rows open the owning workbench. */
export function ToolJobList({ rows, isLoading, error, onRetry, empty, footer, testId }: {
  rows: ToolJobRow[]; isLoading: boolean; error?: unknown; onRetry?: () => void; empty: ReactNode; footer?: ReactNode; testId: string;
}) {
  if (isLoading) return <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-secondary/60" />)}</div>;
  if (error) return <ErrorNotice testId={`${testId}-error`} title="Could not load jobs" message="Check your connection and try again." onRetry={onRetry} />;
  if (rows.length === 0) return <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground" data-testid={`${testId}-empty`}>{empty}</div>;
  return (
    <div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" data-testid={testId}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={r.href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary" data-testid={`${testId}-row-${r.id}`}>
              {r.thumbUrl ? <img src={r.thumbUrl} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" /> : <span className="size-10 shrink-0 rounded bg-secondary/60" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{[r.subtitle, r.createdAt && new Date(r.createdAt).toLocaleString()].filter(Boolean).join(" / ")}</span>
                {r.error && <span className="block truncate text-[11px] text-destructive">{r.error}</span>}
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tone(r.status)}`}>{r.status.toLowerCase()}</span>
            </Link>
          </li>
        ))}
      </ul>
      {footer}
    </div>
  );
}
