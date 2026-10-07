import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { ANGLE_LIMIT, CPS_MAX, CPS_MIN, INK_MAX, INK_MIN, MAX_PROTECTED, PIXEL_MAX_SECONDS, PIXEL_MIN_SECONDS } from "./pixel-validation";
import type { GarmentReference } from "./types";
import type { GuidedStep } from "./guided-steps";
import { Check, ChevronDown, Eye, EyeOff, ImagePlus, Loader2, ShieldCheck, X } from "lucide-react";

const STEPS = ["Choose a video", "Mark what should move", "Preview and save"] as const;

export function StepRail({ step }: { step: GuidedStep }) {
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Progress" data-testid="preserve-steps">
      {STEPS.map((label, i) => {
        const n = (i + 1) as GuidedStep;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={label} aria-current={state === "current" ? "step" : undefined} data-testid={`step-preserve-${n}`}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${state === "current" ? "border-primary bg-primary/10 font-semibold text-foreground" : state === "done" ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground"}`}>
            <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] ${state === "todo" ? "bg-secondary" : "bg-primary text-primary-foreground"}`}>
              {state === "done" ? <Check className="size-3" /> : n}
            </span>
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{["Video", "Select", "Save"][i]}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface AdvancedProps {
  start: number; startDraft: string; setStartDraft: (v: string) => void; commitStart: (v: string) => void;
  duration: number; onDuration: (v: number) => void;
  angle: number; onAngle: (v: number) => void;
  cps: number; onCps: (v: number) => void;
  ink: number; onInk: (v: number) => void;
  showInk: boolean; onToggleInk: () => void; inkUnavailable: boolean; closed: boolean; previewing: boolean;
  protectCount: number; protecting: boolean; onProtect: () => void;
  plate: GarmentReference | null; plateUploading: boolean; onPlateUpload: (f: File) => void; onPlateClear: () => void;
  title: string; onTitle: (v: string) => void; titlePlaceholder: string;
  target: string; onTarget: (v: string) => void; targetPlaceholder: string;
}

const field = "mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

export function AdvancedPanel(p: AdvancedProps) {
  const plateInput = useRef<HTMLInputElement>(null);
  return (
    <details className="group rounded-2xl border border-border bg-card" data-testid="details-preserve-advanced">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden" data-testid="button-preserve-advanced">
        <span>Advanced <span className="font-normal text-muted-foreground">optional adjustments</span></span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-6 border-t border-border p-4 md:grid-cols-2">
        <section aria-labelledby="adv-window">
          <h3 id="adv-window" className="text-xs font-semibold">Which part of the video</h3>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="text-xs"><span className="text-muted-foreground">Start (s)</span>
              <input type="number" min={0} step={0.05} value={p.startDraft} disabled={p.previewing}
                onChange={(e) => p.setStartDraft(e.target.value)} onBlur={(e) => p.commitStart(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") p.commitStart((e.target as HTMLInputElement).value); }}
                className={`${field} font-mono`} data-testid="input-preserve-start" />
            </label>
            <label className="text-xs"><span className="text-muted-foreground">Length (s)</span>
              <input type="number" min={PIXEL_MIN_SECONDS} max={PIXEL_MAX_SECONDS} step={0.1} value={p.duration}
                onChange={(e) => p.onDuration(Number(e.target.value))} className={`${field} font-mono`} data-testid="input-preserve-duration" />
            </label>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Changing the start loads a new frame and clears your selection.</p>
        </section>

        <section aria-labelledby="adv-motion">
          <h3 id="adv-motion" className="text-xs font-semibold">Fine motion</h3>
          <Slider label="Swing angle" value={p.angle} min={-ANGLE_LIMIT} max={ANGLE_LIMIT} step={1} unit="°" onChange={p.onAngle} testId="slider-angle" />
          <Slider label="Swings per second" value={p.cps} min={CPS_MIN} max={CPS_MAX} step={0.1} unit="" onChange={p.onCps} testId="slider-cps" />
          <Slider label="Artwork detection" value={p.ink} min={INK_MIN} max={INK_MAX} step={1} unit="" onChange={p.onInk} testId="slider-ink" />
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!p.closed || p.previewing || p.inkUnavailable} onClick={p.onToggleInk} aria-pressed={p.showInk} data-testid="button-toggle-ink">
              {p.showInk ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{p.showInk ? "Hide detected artwork" : "Show detected artwork"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{p.inkUnavailable ? "Highlight unavailable in this browser; the server still applies it." : "Raise detection if the background gets highlighted."}</p>
        </section>

        <section aria-labelledby="adv-protect">
          <h3 id="adv-protect" className="text-xs font-semibold">Keep-still areas</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">Outline text, logos or details that must never move. {p.protectCount}/{MAX_PROTECTED} used.</p>
          <Button size="sm" variant="secondary" className="mt-2" disabled={p.protecting || p.previewing || p.protectCount >= MAX_PROTECTED} onClick={p.onProtect} data-testid="button-tool-protect-start">
            <ShieldCheck className="size-3.5" />{p.protecting ? "Drawing on the frame" : "Add keep-still area"}
          </Button>
        </section>

        <section aria-labelledby="adv-plate">
          <h3 id="adv-plate" className="text-xs font-semibold">Clean plate <span className="font-normal text-muted-foreground">(optional)</span></h3>
          <p className="mt-1 text-[11px] text-muted-foreground">The same frame at {p.start.toFixed(2)}s without the artwork. Improves the area the moving part uncovers.</p>
          {p.plate ? (
            <div className="mt-2 flex items-center gap-3">
              <img src={p.plate.mediaUrl} alt="Uploaded clean plate" className="h-12 w-20 rounded object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs" data-testid="text-plate-name">{p.plate.name}</span>
              <Button variant="ghost" size="icon" aria-label="Remove clean plate" onClick={p.onPlateClear} data-testid="button-plate-clear"><X className="size-4" /></Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" className="mt-2" disabled={p.plateUploading} onClick={() => plateInput.current?.click()} data-testid="button-plate-upload">
              {p.plateUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}Upload plate
            </Button>
          )}
          <input ref={plateInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose clean plate image"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) p.onPlateUpload(f); }} />
        </section>

        <section aria-labelledby="adv-name" className="md:col-span-2">
          <h3 id="adv-name" className="text-xs font-semibold">Name and note</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-xs"><span className="text-muted-foreground">Title</span>
              <input value={p.title} maxLength={120} placeholder={p.titlePlaceholder} onChange={(e) => p.onTitle(e.target.value)} className={field} data-testid="input-preserve-title" />
            </label>
            <label className="text-xs"><span className="text-muted-foreground">What the artwork is on</span>
              <input value={p.target} maxLength={160} placeholder={p.targetPlaceholder} onChange={(e) => p.onTarget(e.target.value)} className={field} data-testid="input-preserve-target" />
            </label>
          </div>
        </section>

        <p className="text-[11px] leading-relaxed text-muted-foreground md:col-span-2" data-testid="text-preserve-details">
          How it works: only the selected pixels rotate around the attachment point within a limited angle; nothing is redrawn by AI and text instructions are not used.
          Local motion tracking follows visible movement but cannot recover artwork that gets hidden by folds or hands. Uncovered gaps are filled from surrounding pixels, which can smear on busy patterns.
        </p>
      </div>
    </details>
  );
}

function Slider({ label, value, min, max, step, unit, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; testId: string }) {
  return (
    <label className="mt-2 block text-xs">
      <span className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="font-mono">{value}{unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[hsl(var(--primary))]" data-testid={testId} />
    </label>
  );
}
