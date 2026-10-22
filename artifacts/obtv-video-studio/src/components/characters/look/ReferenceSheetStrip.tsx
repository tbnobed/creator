import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { LookSlot } from "@/lib/character-look-adapters";

/** Front / three-quarter / profile / expression views made from the kept look. */
export function ReferenceSheetStrip({ slots, pendingText, footer }: { slots: LookSlot[]; pendingText?: string; footer?: ReactNode }) {
  return (
    <div data-testid="reference-sheet">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reference sheet</p>
      {slots.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="text-reference-pending">{pendingText ?? "Front, three-quarter, profile and expression views are being prepared."}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {slots.map((slot) => (
            <figure key={slot.key} className="min-w-0">
              {slot.state === "READY" && slot.mediaUrl
                ? <img src={slot.mediaUrl} alt={slot.label ?? "reference"} className="aspect-[3/4] w-full rounded-md object-cover" />
                : <div className="flex aspect-[3/4] items-center justify-center rounded-md bg-muted/40 text-[10px] text-muted-foreground" title={slot.error}>
                    {slot.state === "FAILED" ? <><AlertTriangle className="mr-1 size-3 text-destructive" />Failed</> : <Loader2 className="size-3 animate-spin text-primary" />}
                  </div>}
              <figcaption className="mt-1 truncate text-[10px] text-muted-foreground">{slot.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}
