import { Link } from "wouter";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";

export type BatchReceipt =
  | { index: number; state: "pending" }
  | { index: number; state: "accepted"; jobId: string }
  | { index: number; state: "failed"; message: string };

export function BatchCountPicker({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Batch size" className="flex h-8 items-center rounded-md border border-[#4a3c49] p-0.5" data-testid="group-batch-count">
      {[1, 2, 3, 4].map((count) => (
        <button key={count} type="button" disabled={disabled} aria-pressed={value === count} onClick={() => onChange(count)}
          className={`h-6 min-w-6 rounded px-1.5 text-[11px] font-mono ${value === count ? "bg-[#703753] text-white" : "text-[#bdaebd] hover:bg-[#3c303e]"} disabled:opacity-40`}
          data-testid={`button-batch-count-${count}`}>{count}x</button>
      ))}
    </div>
  );
}

export function BatchReceipts({ receipts, onDismiss }: { receipts: BatchReceipt[]; onDismiss: () => void }) {
  if (receipts.length < 2) return null;
  const accepted = receipts.filter((r) => r.state === "accepted").length;
  const failed = receipts.filter((r) => r.state === "failed").length;
  const pending = receipts.length - accepted - failed;
  return (
    <div className="mb-2 rounded-xl border border-[#604257] bg-[#2d222c] p-3 text-xs text-[#eadfe8]" role="status" data-testid="panel-batch-receipts">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-semibold" data-testid="text-batch-summary">
          Batch: {accepted} accepted{failed ? ` · ${failed} failed` : ""}{pending ? ` · ${pending} submitting` : ""}
        </p>
        {!pending && <button type="button" onClick={onDismiss} aria-label="Dismiss batch receipts" className="rounded p-1 hover:bg-[#42313e]" data-testid="button-dismiss-batch"><X className="size-3.5" /></button>}
      </div>
      <ul className="space-y-1">
        {receipts.map((r) => (
          <li key={r.index} className="flex items-center gap-2" data-testid={`row-batch-receipt-${r.index}`}>
            <span className="w-12 font-mono text-[10px] text-[#a99ba8]">Take {r.index + 1}</span>
            {r.state === "pending" && <><Loader2 className="size-3.5 animate-spin text-[#c9b9c7]" /> Submitting</>}
            {r.state === "accepted" && <><Check className="size-3.5 text-emerald-300" /> Accepted <Link href={`/generations/${r.jobId}`} className="underline underline-offset-2" data-testid={`link-batch-job-${r.index}`}>Open job</Link></>}
            {r.state === "failed" && <><AlertTriangle className="size-3.5 text-rose-300" /> <span className="text-rose-200">Not queued: {r.message}</span></>}
          </li>
        ))}
      </ul>
      {failed > 0 && <p className="mt-2 text-[11px] text-[#bdaabc]">Failed takes were not retried automatically. Check the gallery before resubmitting to avoid duplicate charges.</p>}
    </div>
  );
}
