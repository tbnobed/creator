import { AlertCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function readableError(error: unknown, fallback = "Something went wrong."): string {
  const e = error as { data?: { error?: unknown; message?: unknown } | null; message?: unknown } | null;
  const raw = e?.data?.error ?? e?.data?.message ?? e?.message ?? (typeof error === "string" ? error : undefined);
  return typeof raw === "string" && raw.trim() ? raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : fallback;
}

/** Shared inline error with optional retry and dismiss; replaces browser alerts. */
export function ErrorNotice({ title, message, onRetry, retrying, onDismiss, className = "", testId = "status-error" }: {
  title?: string; message: string; onRetry?: () => void; retrying?: boolean; onDismiss?: () => void; className?: string; testId?: string;
}) {
  return (
    <div role="alert" data-testid={testId} className={`flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm ${className}`}>
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <p className="text-foreground/85">{message}</p>
      </div>
      {onRetry && <Button size="sm" variant="outline" className="gap-1.5" onClick={onRetry} disabled={retrying} data-testid={`${testId}-retry`}><RefreshCw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} /> Retry</Button>}
      {onDismiss && <Button size="icon" variant="ghost" className="size-7" onClick={onDismiss} aria-label="Dismiss error" data-testid={`${testId}-dismiss`}><X className="size-3.5" /></Button>}
    </div>
  );
}
