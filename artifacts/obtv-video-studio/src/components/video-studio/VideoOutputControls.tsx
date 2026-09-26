import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AspectRatio, OutputResolution } from "@/lib/video-model-capabilities";

const ratioBox: Record<AspectRatio, string> = {
  "16:9": "h-2.5 w-[18px]", "4:3": "h-3 w-4", "1:1": "size-3.5", "3:4": "h-4 w-3", "9:16": "h-[18px] w-2.5", "21:9": "h-2 w-5",
};

export function VideoOutputControls({ aspectRatios, aspectRatio, onAspectRatio, aspectLocked, resolutions, resolution, onResolution, format, onFormat }: {
  aspectRatios: readonly AspectRatio[];
  aspectRatio: AspectRatio;
  onAspectRatio: (value: AspectRatio) => void;
  aspectLocked: boolean;
  resolutions: readonly OutputResolution[];
  resolution: OutputResolution;
  onResolution: (value: OutputResolution) => void;
  format: "mp4" | "mov";
  onFormat: (value: "mp4" | "mov") => void;
}) {
  return (
    <div className="space-y-3" data-testid="section-video-output">
      {aspectRatios.length > 0 && <div className="space-y-2">
        <Label>Aspect ratio</Label>
        {aspectLocked ? <p className="text-[11px] text-muted-foreground" data-testid="text-aspect-inherited">Edit and Extend keep the source video's shape automatically.</p> :
        <div role="radiogroup" aria-label="Aspect ratio" className="grid grid-cols-6 gap-1.5">
          {aspectRatios.map((ratio) => (
            <button key={ratio} type="button" role="radio" aria-checked={aspectRatio === ratio} onClick={() => onAspectRatio(ratio)}
              className={`flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-[10px] font-mono ${aspectRatio === ratio ? "border-[#ee87b4] bg-[#703753] text-white" : "border-[#574350] text-[#c9b9c7] hover:bg-[#42313e]"}`}
              data-testid={`button-aspect-${ratio.replace(":", "x")}`}>
              <span className="flex h-5 items-center"><span className={`rounded-[2px] border border-current ${ratioBox[ratio]}`} /></span>{ratio}
            </button>
          ))}
        </div>}
      </div>}
      {resolutions.length > 0 && <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Output resolution</Label>
          <Select value={resolution} onValueChange={(v) => onResolution(v as OutputResolution)}>
            <SelectTrigger className="bg-secondary/20" data-testid="select-output-resolution"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[70]">
              {resolutions.map((r) => <SelectItem key={r} value={r}>{r === "4k" ? "4K" : r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Format</Label>
          <div role="radiogroup" aria-label="Output format" className="flex h-9 items-center gap-1.5">
            {(["mp4", "mov"] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={format === value} onClick={() => onFormat(value)}
                className={`rounded-md border px-2.5 py-1 text-[11px] uppercase ${format === value ? "border-[#ee87b4] bg-[#703753] text-white" : "border-[#574350] text-[#c9b9c7] hover:bg-[#42313e]"}`}
                data-testid={`button-format-${value}`}>{value}</button>
            ))}
          </div>
        </div>
      </div>}
    </div>
  );
}
