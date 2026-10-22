import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { sceneRangeLabel, type OutfitView } from "@/lib/wardrobe-adapters";
import { MediaFrame, MediaTile } from "./MediaTile";

/** One outfit presentation for the character library and the production wardrobe step. */
export function OutfitCard({ outfit, actions, children, testId, className, showMedia = true }: {
  outfit: OutfitView; actions?: ReactNode; children?: ReactNode; testId?: string; className?: string; showMedia?: boolean;
}) {
  return (
    <MediaTile testId={testId} className={className} actions={actions}
      media={showMedia ? <MediaFrame src={outfit.mediaUrl} state={outfit.mediaState} alt={outfit.name} error={outfit.error} /> : undefined}
      title={children ? undefined : outfit.name}
      badges={outfit.approval === "approved" ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400" data-testid="badge-outfit-reference"><CheckCircle2 className="h-2.5 w-2.5" /> Reference set</span> : undefined}
      meta={(outfit.sceneRange || outfit.stateChange) && <>
        {outfit.sceneRange && <p data-testid="text-outfit-scenes">{sceneRangeLabel(outfit.sceneRange)}</p>}
        {outfit.stateChange && <p className="text-violet-300">{outfit.stateChange.note}{outfit.stateChange.fromScene ? ` from scene ${outfit.stateChange.fromScene}` : ""}</p>}
      </>}
      error={outfit.error}>
      {children}
    </MediaTile>
  );
}
