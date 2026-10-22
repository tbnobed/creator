import { AlertTriangle, Check, Loader2, Lock } from "lucide-react";
import type { LookSlot } from "@/lib/character-look-adapters";

/** Four portrait options as a radio group; identical in the library and in Long-Form. */
export function LookOptionGrid({ slots, choice, onChoose, keptAssetId, disabled }: {
  slots: LookSlot[]; choice: string | null | undefined; onChoose: (assetId: string) => void; keptAssetId?: string | null; disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Portrait options">
      {slots.map((slot, i) => {
        if (slot.state === "READY" && slot.assetId && slot.mediaUrl) {
          const id = slot.assetId;
          const selected = choice === id;
          return (
            <button key={slot.key} type="button" role="radio" aria-checked={selected} aria-label={`Option ${i + 1}`} disabled={disabled} onClick={() => onChoose(id)}
              className={`relative overflow-hidden rounded-lg border-2 transition-all ${selected ? "border-primary" : "border-transparent hover:border-foreground/30"}`}
              data-testid={`option-portrait-${i}`}>
              <img src={slot.mediaUrl} alt={`Option ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
              {selected && <span className="absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 text-primary-foreground"><Check className="size-3" /></span>}
              {keptAssetId === id && <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground"><Lock className="size-2.5" /> Kept</span>}
            </button>
          );
        }
        return (
          <div key={slot.key} className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-1 text-center text-xs text-muted-foreground" title={slot.error} data-testid={`slot-portrait-${i}-${slot.state.toLowerCase()}`}>
            {slot.state === "PENDING" ? <><Loader2 className="size-4 animate-spin text-primary" /><span className="sr-only">Generating</span></>
              : slot.state === "FAILED" ? <><AlertTriangle className="size-4 text-destructive" /> Failed</>
              : `Option ${i + 1}`}
          </div>
        );
      })}
    </div>
  );
}
