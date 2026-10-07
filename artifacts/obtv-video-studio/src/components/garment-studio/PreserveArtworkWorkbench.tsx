import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GarmentJob as ApiGarmentJob } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ResultPanel } from "./GarmentWorkbench";
import { isActiveJob } from "./validation";
import type { GarmentReference, GarmentSource } from "./types";
import {
  MAX_PROTECTED, PIXEL_MAX_SECONDS, PIXEL_MIN_SECONDS, POLY_MAX,
  clamp01, pixelSubmitBlocker, roundPoly,
} from "./pixel-validation";
import type { Pt } from "./pixel-validation";
import { DEFAULT_TARGET, DEFAULT_TITLE, MOTION_PRESETS, effectiveTarget, effectiveTitle, guide, presetFor } from "./guided-steps";
import { AdvancedPanel, StepRail } from "./PreserveParts";
import {
  AlertTriangle, ArrowRight, Check, Crosshair, Film, Loader2, Pause, Pentagon, Play, Recycle, ShieldCheck, Sparkles, Trash2, Undo2, Upload,
} from "lucide-react";

export interface PreserveSubmitRequest {
  prompt: string;
  targetGarment: string;
  startSeconds: number;
  durationSeconds: number;
  seed: number;
  pixelAnimation: {
    polygon: Pt[];
    pivot: Pt;
    angleDegrees: number;
    cyclesPerSecond: number;
    inkThreshold: number;
    protectedPolygons?: Pt[][];
    cleanPlateStorageKey?: string;
  };
}

interface Props {
  source: GarmentSource | null;
  job: ApiGarmentJob | null;
  loading: boolean;
  error: string | null;
  onUpload: (file: File) => void;
  onSubmit: (req: PreserveSubmitRequest) => void;
  onCancel: (jobId: string) => void;
  plate: GarmentReference | null;
  plateUploading: boolean;
  onPlateUpload: (file: File) => void;
  onPlateClear: () => void;
  onUseResult: (jobId: string) => void;
  usingResult: boolean;
  onInputChange: () => void;
  /** True while ANY garment job is queued/running, not just the selected one. */
  anyActiveJob?: boolean;
  /** Most recent finished job that can be reused as a starting video. */
  recentResult?: ApiGarmentJob | null;
}

type Tool = "outline" | "pivot" | "protect";
const MAX_CANVAS = 1280;

function tracePath(ctx: CanvasRenderingContext2D, poly: Pt[], w: number, h: number, close: boolean) {
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
  if (close) ctx.closePath();
}

export function PreserveArtworkWorkbench({
  source, job, loading, error, onUpload, onSubmit, onCancel, plate, plateUploading, onPlateUpload, onPlateClear, onUseResult, usingResult, onInputChange, anyActiveJob = false, recentResult = null,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const inkRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);

  const [start, setStart] = useState(0);
  const [startDraft, setStartDraft] = useState("0");
  const [duration, setDuration] = useState(2);
  const [frameState, setFrameState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [frameVersion, setFrameVersion] = useState(0);
  const [tool, setTool] = useState<Tool>("outline");
  const [polygon, setPolygon] = useState<Pt[]>([]);
  const [closed, setClosed] = useState(false);
  const [pivot, setPivot] = useState<Pt | null>(null);
  const [protectedPolys, setProtectedPolys] = useState<Pt[][]>([]);
  const [draftProtect, setDraftProtect] = useState<Pt[]>([]);
  const [angle, setAngle] = useState(14);
  const [cps, setCps] = useState(0.8);
  const [ink, setInk] = useState(28);
  const [showInk, setShowInk] = useState(true);
  const [inkUnavailable, setInkUnavailable] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [title, setTitle] = useState("");
  const [targetGarment, setTargetGarment] = useState("");

  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;
  const onPlateClearRef = useRef(onPlateClear);
  onPlateClearRef.current = onPlateClear;
  const [cursor, setCursor] = useState<Pt>({ x: 0.5, y: 0.5 });
  const [focused, setFocused] = useState(false);

  const total = source?.durationSeconds;
  const dims = useMemo(() => {
    if (!source) return { w: 16, h: 9 };
    const s = Math.min(1, MAX_CANVAS / Math.max(source.width, source.height));
    return { w: Math.max(1, Math.round(source.width * s)), h: Math.max(1, Math.round(source.height * s)) };
  }, [source]);

  const resetSelection = useCallback(() => {
    setPolygon([]); setClosed(false); setPivot(null); setProtectedPolys([]); setDraftProtect([]);
    setPreviewing(false); setReviewed(false); setTool("outline");
  }, []);

  // New source: reset window and every selection.
  const sourceKey = source ? `${source.mediaUrl}|${source.durationSeconds}` : "";
  useEffect(() => {
    resetSelection();
    setStart(0); setStartDraft("0");
    setCursor({ x: 0.5, y: 0.5 });
    frameRef.current = null;
    inkRef.current = null;
    onPlateClearRef.current();
    if (source) setDuration(Math.min(2, Math.floor(source.durationSeconds * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Seek to start and grab the still frame. Selections are relative to THIS frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !source) { setFrameState("idle"); return; }
    setFrameState("loading");
    let done = false;
    const grab = () => {
      if (done) return;
      done = true;
      const c = frameRef.current ?? document.createElement("canvas");
      c.width = dims.w; c.height = dims.h;
      const ctx = c.getContext("2d");
      if (!ctx) { setFrameState("error"); return; }
      ctx.drawImage(v, 0, 0, dims.w, dims.h);
      frameRef.current = c;
      setFrameState("ready");
      setFrameVersion((n) => n + 1);
    };
    const seek = () => {
      const target = Math.min(start, Math.max(0, (v.duration || start) - 0.05));
      if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) { grab(); return; }
      v.addEventListener("seeked", grab, { once: true });
      v.currentTime = target;
    };
    const fail = () => setFrameState("error");
    v.addEventListener("error", fail);
    if (v.readyState >= 1) seek(); else v.addEventListener("loadedmetadata", seek, { once: true });
    return () => {
      done = true;
      v.removeEventListener("error", fail);
      v.removeEventListener("seeked", grab);
      v.removeEventListener("loadedmetadata", seek);
    };
  }, [sourceKey, start, dims.w, dims.h, source]);

  // Ink mask: pixels inside the outline whose colour departs from the cloth colour sampled at the outline points.
  useEffect(() => {
    inkRef.current = null;
    setInkUnavailable(false);
    const frame = frameRef.current;
    if (!frame || !closed || polygon.length < 3) return;
    try {
      const fctx = frame.getContext("2d")!;
      const img = fctx.getImageData(0, 0, dims.w, dims.h);
      const d = img.data;
      let r = 0, g = 0, b = 0;
      for (const p of polygon) {
        const i = (Math.min(dims.h - 1, Math.round(p.y * dims.h)) * dims.w + Math.min(dims.w - 1, Math.round(p.x * dims.w))) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2];
      }
      r /= polygon.length; g /= polygon.length; b /= polygon.length;
      const mask = document.createElement("canvas");
      mask.width = dims.w; mask.height = dims.h;
      const mctx = mask.getContext("2d")!;
      mctx.fillStyle = "#000"; tracePath(mctx, polygon, dims.w, dims.h, true); mctx.fill();
      const inside = mctx.getImageData(0, 0, dims.w, dims.h);
      const out = mctx.createImageData(dims.w, dims.h);
      for (let i = 0; i < d.length; i += 4) {
        if (inside.data[i + 3] < 128) continue;
        const dist = Math.sqrt(((d[i] - r) ** 2 + (d[i + 1] - g) ** 2 + (d[i + 2] - b) ** 2) / 3);
        if (dist > ink) { out.data[i] = 255; out.data[i + 1] = 70; out.data[i + 2] = 190; out.data[i + 3] = 150; }
      }
      mctx.putImageData(out, 0, 0);
      inkRef.current = mask;
    } catch {
      setInkUnavailable(true);
    }
  }, [polygon, closed, ink, dims.w, dims.h, frameVersion]);

  const draw = useCallback((t: number | null) => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const { w, h } = dims;
    ctx.clearRect(0, 0, w, h);
    const frame = frameRef.current;
    if (frame && frameState === "ready") ctx.drawImage(frame, 0, 0);
    const lw = Math.max(1.5, w / 500);

    if (t !== null && frame && closed && pivot) {
      const a = (angle * Math.PI / 180) * Math.sin(2 * Math.PI * cps * t);
      ctx.save();
      ctx.translate(pivot.x * w, pivot.y * h); ctx.rotate(a); ctx.translate(-pivot.x * w, -pivot.y * h);
      tracePath(ctx, polygon, w, h, true); ctx.clip();
      ctx.drawImage(frame, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.translate(pivot.x * w, pivot.y * h); ctx.rotate(a); ctx.translate(-pivot.x * w, -pivot.y * h);
      ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeStyle = "rgba(255,120,210,0.95)"; ctx.lineWidth = lw;
      tracePath(ctx, polygon, w, h, true); ctx.stroke();
      ctx.restore();
    } else {
      if (showInk && inkRef.current) ctx.drawImage(inkRef.current, 0, 0);
      if (polygon.length) {
        ctx.strokeStyle = "rgba(255,120,210,0.95)"; ctx.lineWidth = lw; ctx.setLineDash(closed ? [] : [lw * 3, lw * 2]);
        tracePath(ctx, polygon, w, h, closed); ctx.stroke();
        if (closed) { ctx.fillStyle = "rgba(200,90,255,0.12)"; ctx.fill(); }
        ctx.setLineDash([]);
        polygon.forEach((p, i) => {
          ctx.beginPath(); ctx.arc(p.x * w, p.y * h, lw * (i === 0 && !closed ? 3.2 : 2), 0, Math.PI * 2);
          ctx.fillStyle = i === 0 && !closed ? "#ffd2f0" : "#ff78d2"; ctx.fill();
        });
      }
    }
    for (const poly of [...protectedPolys, draftProtect]) {
      if (!poly.length) continue;
      const isDraft = poly === draftProtect;
      ctx.setLineDash(isDraft ? [lw * 3, lw * 2] : []);
      ctx.strokeStyle = "rgba(120,230,255,0.95)"; ctx.lineWidth = lw;
      tracePath(ctx, poly, w, h, !isDraft); ctx.stroke();
      if (!isDraft) { ctx.fillStyle = "rgba(120,230,255,0.14)"; ctx.fill(); }
      poly.forEach((p) => { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, lw * 1.6, 0, Math.PI * 2); ctx.fillStyle = "#78e6ff"; ctx.fill(); });
    }
    ctx.setLineDash([]);
    if (pivot) {
      const x = pivot.x * w, y = pivot.y * h, s = lw * 6;
      ctx.strokeStyle = "#fff6c8"; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, s * 0.55, 0, Math.PI * 2); ctx.stroke();
    }
    if (focused && t === null && frameState === "ready") {
      const x = cursor.x * w, y = cursor.y * h, s = lw * 8;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = lw;
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      ctx.beginPath(); ctx.arc(x, y, lw, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
    }
  }, [dims, frameState, polygon, closed, pivot, protectedPolys, draftProtect, angle, cps, showInk, focused, cursor]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!previewing) { draw(null); return; }
    const t0 = performance.now();
    const loop = (now: number) => { draw((now - t0) / 1000); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw, previewing, frameVersion, inkUnavailable]);

  // Guide the tool automatically: after the outline closes, the next click places the attachment point.
  useEffect(() => {
    if (closed && !pivot) setTool((t) => (t === "outline" ? "pivot" : t));
    if (!closed) setTool((t) => (t === "pivot" ? "outline" : t));
  }, [closed, pivot]);

  const touched = useCallback(() => { setReviewed(false); onInputChangeRef.current(); }, []);

  /** Places a normalized point with the current tool. pxW/pxH convert the close-snap radius to screen pixels. */
  function placePoint(p: Pt, pxW: number, pxH: number) {
    if (frameState !== "ready" || previewing) return;
    const nearFirst = (poly: Pt[]) => poly.length >= 3 && Math.hypot((poly[0].x - p.x) * pxW, (poly[0].y - p.y) * pxH) < 14;
    if (tool === "pivot") { setPivot(p); touched(); return; }
    if (tool === "outline") {
      if (closed) return;
      if (nearFirst(polygon)) { setClosed(true); touched(); return; }
      if (polygon.length >= POLY_MAX) return;
      setPolygon((prev) => [...prev, p]); touched(); return;
    }
    if (protectedPolys.length >= MAX_PROTECTED) return;
    if (nearFirst(draftProtect)) { closeProtect(); return; }
    if (draftProtect.length < POLY_MAX) { setDraftProtect((prev) => [...prev, p]); touched(); }
  }

  function handlePointer(e: React.PointerEvent<HTMLCanvasElement>) {
    // Canvas keeps its intrinsic aspect ratio via its wrapper, so the bounding rect equals the drawn frame (no letterbox).
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const p = { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
    setCursor(p);
    placePoint(p, rect.width, rect.height);
  }

  function handleKey(e: React.KeyboardEvent<HTMLCanvasElement>) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      setCursor((c) => ({ x: Math.round(clamp01(c.x + dx) * 1000) / 1000, y: Math.round(clamp01(c.y + dy) * 1000) / 1000 }));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      placePoint(cursor, rect.width || 1, rect.height || 1);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      undo();
    }
  }

  function closeProtect() {
    if (draftProtect.length < 3) return;
    setProtectedPolys((prev) => [...prev, draftProtect]); setDraftProtect([]); touched();
  }

  function undo() {
    if (tool === "protect" && draftProtect.length) { setDraftProtect((p) => p.slice(0, -1)); touched(); return; }
    if (tool === "protect" && protectedPolys.length) { setProtectedPolys((p) => p.slice(0, -1)); touched(); return; }
    if (tool === "pivot" && pivot) { setPivot(null); touched(); return; }
    if (closed) { setClosed(false); setPreviewing(false); touched(); return; }
    if (polygon.length) { setPolygon((p) => p.slice(0, -1)); touched(); }
  }

  function commitStart(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { setStartDraft(String(start)); return; }
    const max = Math.max(0, (total ?? 0) - PIXEL_MIN_SECONDS);
    const v = Math.round(Math.min(n, max) * 100) / 100;
    setStartDraft(String(v));
    if (v !== start) { setStart(v); resetSelection(); onPlateClear(); onInputChangeRef.current(); }
  }

  const active = isActiveJob(job);
  const jobRunning = active || anyActiveJob;
  const busy = loading || plateUploading || usingResult;
  const title2 = effectiveTitle(title);
  const blocker = pixelSubmitBlocker({
    hasSource: Boolean(source) && frameState === "ready", polygon, closed, pivot, protectedPolygons: protectedPolys,
    pendingProtectPoints: draftProtect.length,
    start, duration, total, angle, cps, ink, reviewed, title: title2, busy, activeJob: jobRunning,
  });
  const canUseResult = job && job.status === "succeeded" && Boolean(job.outputUrl) && !jobRunning;
  const g = guide({ hasSource: Boolean(source), frameReady: frameState === "ready", points: polygon.length, closed, hasPivot: Boolean(pivot), reviewed });
  const preset = presetFor(angle, cps);
  const step3Ready = closed && Boolean(pivot) && frameState === "ready";

  function submit() {
    if (blocker || !pivot) return;
    onSubmit({
      prompt: title2,
      targetGarment: effectiveTarget(targetGarment),
      startSeconds: start,
      durationSeconds: duration,
      seed: 0,
      pixelAnimation: {
        polygon: roundPoly(polygon),
        pivot: roundPoly([pivot])[0],
        angleDegrees: angle,
        cyclesPerSecond: cps,
        inkThreshold: ink,
        ...(protectedPolys.length ? { protectedPolygons: protectedPolys.map(roundPoly) } : {}),
        ...(plate ? { cleanPlateStorageKey: plate.storageKey } : {}),
      },
    });
  }

  const selectionStatus = !closed
    ? polygon.length ? `Selection open: ${polygon.length} dot${polygon.length === 1 ? "" : "s"}` : "No selection yet"
    : `Selection finished: ${polygon.length} dots`;

  const fileField = (
    <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="sr-only" aria-label="Choose source video"
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onUpload(f); }} />
  );
  const showResult = Boolean(job);

  return (
    <div className="space-y-5" data-testid="preserve-workbench">
      <StepRail step={g.step} />

      {!source ? (
        <section aria-labelledby="preserve-upload-heading"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onUpload(f); }}
          className="grid gap-6 rounded-2xl border-2 border-dashed border-primary/30 bg-card p-6 md:grid-cols-[1fr_auto] md:items-center md:p-10">
          <div>
            <h2 id="preserve-upload-heading" className="text-xl font-semibold tracking-tight">{usingResult ? "Loading that video" : loading ? "Uploading your video" : "Choose a video"}</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground" data-testid="text-preserve-explainer">
              Make one part of any visible artwork swing back and forth, using the original pixels. Drop an MP4 or MOV here.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="lg" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="button-preserve-upload">
                {loading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}Upload video
              </Button>
              {recentResult && (
                <Button size="lg" variant="secondary" disabled={busy || jobRunning} onClick={() => onUseResult(recentResult.id)} data-testid="button-preserve-use-recent">
                  {usingResult ? <Loader2 className="size-4 animate-spin" /> : <Recycle className="size-4" />}Continue from "{recentResult.title}"
                </Button>
              )}
            </div>
            {fileField}
            {error && <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs" data-testid="text-preserve-error">{error}</p>}
          </div>
          <div className="hidden size-28 items-center justify-center rounded-full bg-primary/10 md:flex" aria-hidden="true">
            <Film className="size-10 text-primary" />
          </div>
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="preserve-editor-heading" className="min-w-0 rounded-2xl border border-border bg-card p-4">
            <div className="mb-3 flex items-start gap-3 rounded-xl border-l-4 border-primary bg-primary/10 px-4 py-3" aria-live="polite" data-testid="text-next-action">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{g.step}</span>
              <div className="min-w-0">
                <h2 id="preserve-editor-heading" className="text-base font-semibold leading-tight">{g.action}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="text-tool-help">
                  {tool === "protect" ? `Keeping still: click around text or details that must not move, then Close area (max ${MAX_PROTECTED}).` : g.detail}
                </p>
              </div>
            </div>

            <div role="radiogroup" aria-label="What your next click does" className="mb-3 flex flex-wrap items-center gap-1.5">
              {([
                ["outline", "1. Select moving part", Pentagon, true],
                ["pivot", "2. Attachment point", Crosshair, closed],
                ...(tool === "protect" ? [["protect", "Keep still", ShieldCheck, true] as const] : []),
              ] as const).map(([value, label, Icon, enabled]) => (
                <button key={value} type="button" role="radio" aria-checked={tool === value} disabled={previewing || !enabled}
                  onClick={() => setTool(value)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${tool === value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary"}`}
                  data-testid={`button-tool-${value}`}>
                  <Icon className="size-3.5" />{label}
                </button>
              ))}
              <span className="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="text-selection-status" aria-live="polite">
                {selectionStatus} / {pivot ? "attachment set" : "no attachment"}{protectedPolys.length ? ` / ${protectedPolys.length} kept still` : ""}
              </span>
            </div>

            <div className="rounded-lg bg-black/60">
              <div className="relative mx-auto overflow-hidden" style={{ maxWidth: `min(100%, calc(60dvh * ${dims.w / dims.h}))` }}>
                <canvas ref={canvasRef} width={dims.w} height={dims.h}
                  onPointerDown={handlePointer}
                  onKeyDown={handleKey}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  tabIndex={0}
                  role="application"
                  aria-roledescription="frame editor"
                  aria-label={`Still frame editor. Next: ${g.action}. ${selectionStatus}. ${pivot ? "Attachment point placed." : "No attachment point."} Arrow keys move the cursor (Shift for larger steps), Enter places a dot, Backspace undoes.`}
                  aria-describedby="preserve-cursor-readout"
                  className={`block h-auto w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-primary ${previewing ? "cursor-default" : "cursor-crosshair"}`}
                  data-testid="canvas-preserve-editor" />
                {frameState !== "ready" && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground" data-testid="status-preserve-frame">
                    {frameState === "error" ? <span className="flex items-center gap-1.5 text-destructive"><AlertTriangle className="size-3.5" />Could not read this frame.</span>
                      : <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />Loading frame at {start.toFixed(2)}s</span>}
                  </div>
                )}
                {previewing && (
                  <span className="absolute left-2 top-2 rounded-md bg-background/85 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-primary" data-testid="badge-outline-preview">
                    Motion sketch / still frame only
                  </span>
                )}
              </div>
              <video ref={videoRef} src={source.mediaUrl} muted playsInline preload="auto" className="hidden" aria-hidden="true" />
            </div>
            <p id="preserve-cursor-readout" className="sr-only" aria-live="polite" data-testid="text-cursor-readout">
              Keyboard cursor x {cursor.x.toFixed(3)} / y {cursor.y.toFixed(3)}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {tool === "outline" && !closed && (
                <Button size="sm" disabled={polygon.length < 3 || previewing} onClick={() => { setClosed(true); touched(); }} data-testid="button-preserve-close">
                  <Check className="size-3.5" />Finish selection
                </Button>
              )}
              {tool === "protect" && (
                <>
                  <Button size="sm" variant="secondary" disabled={draftProtect.length < 3} onClick={closeProtect} data-testid="button-protect-close"><Check className="size-3.5" />Close area</Button>
                  <Button size="sm" variant="ghost" disabled={draftProtect.length > 0} onClick={() => setTool(closed ? (pivot ? "outline" : "pivot") : "outline")} data-testid="button-protect-done">Done</Button>
                </>
              )}
              <Button variant="ghost" size="sm" onClick={undo} disabled={previewing} data-testid="button-preserve-undo"><Undo2 className="size-3.5" />Undo</Button>
              <Button variant="ghost" size="sm" disabled={previewing} onClick={() => { resetSelection(); onInputChangeRef.current(); }} data-testid="button-preserve-reset"><Trash2 className="size-3.5" />Start over</Button>
              <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || jobRunning} onClick={() => fileInput.current?.click()} data-testid="button-preserve-replace"><Upload className="size-3.5" />Different video</Button>
              {fileField}
            </div>
          </section>

          <aside aria-labelledby="preserve-step3-heading" className={`h-fit rounded-2xl border bg-card p-4 transition-opacity ${step3Ready ? "border-primary/40" : "border-border opacity-60"}`}>
            <h2 id="preserve-step3-heading" className="flex items-center gap-2 text-sm font-semibold"><span className="flex size-5 items-center justify-center rounded-full bg-secondary text-[11px]">3</span>Preview and save</h2>
            {!step3Ready && <p className="mt-2 text-xs text-muted-foreground" data-testid="text-step3-locked">Unlocks after you select the moving part and its attachment point.</p>}

            <fieldset className="mt-4" disabled={!step3Ready}>
              <legend className="text-xs text-muted-foreground">How much movement</legend>
              <div role="radiogroup" aria-label="Motion level" className="mt-2 grid grid-cols-3 gap-1.5">
                {MOTION_PRESETS.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={preset === p.id}
                    onClick={() => { setAngle(p.angle); setCps(p.cps); touched(); }}
                    className={`rounded-lg border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed ${preset === p.id ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    data-testid={`button-preset-${p.id}`}>
                    <span className="block text-xs font-semibold">{p.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{p.id === "gentle" ? "Small movement" : p.id === "normal" ? "Medium movement" : "Larger movement"}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{preset ? MOTION_PRESETS.find((p) => p.id === preset)?.hint : "Custom values from Advanced"}. A back-and-forth swing only.</p>
            </fieldset>

            <Button size="sm" variant={previewing ? "secondary" : "outline"} className="mt-4 w-full" disabled={!step3Ready}
              onClick={() => setPreviewing((p) => !p)} data-testid="button-outline-preview">
              {previewing ? <><Pause className="size-3.5" />Stop sketch</> : <><Play className="size-3.5" />Play motion sketch</>}
            </Button>
            <p className="mt-1 text-[11px] text-muted-foreground">The sketch moves the still frame only. The real video follows the clip.</p>

            <label className="mt-4 flex items-start gap-2 rounded-lg border border-border p-3 text-xs">
              <input type="checkbox" checked={reviewed} disabled={!step3Ready} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5 accent-[hsl(var(--primary))]" data-testid="checkbox-preserve-reviewed" />
              <span><span className="font-semibold">Looks right.</span> The selection and attachment point are where I want them.</span>
            </label>

            {error && <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs" data-testid="text-preserve-error">{error}</p>}
            <Button size="lg" className="mt-3 w-full" disabled={Boolean(blocker)} onClick={submit} data-testid="button-preserve-render">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{jobRunning ? "Creating video..." : "Create video"}
              {!jobRunning && !loading && <ArrowRight className="size-4" />}
            </Button>
            {blocker && step3Ready && <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-preserve-blocker">{blocker}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-preserve-limits">
              Free, runs locally. Up to {PIXEL_MAX_SECONDS}s, 720p. Works best when the artwork stays flat and unblocked.
            </p>
          </aside>
        </div>
      )}

      {showResult && job && (
        <div className="space-y-2">
          <ResultPanel job={job} sourceUrl={job.sourceUrl ?? source?.mediaUrl ?? undefined} start={job.sourceUrl ? 0 : start} onCancel={onCancel} />
          {canUseResult && (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" disabled={busy || active} onClick={() => onUseResult(job.id)} data-testid="button-use-result-source">
                {usingResult ? <Loader2 className="size-3.5 animate-spin" /> : <Recycle className="size-3.5" />}Animate another part of this result
              </Button>
            </div>
          )}
        </div>
      )}

      {source && (
        <AdvancedPanel
          start={start} startDraft={startDraft} setStartDraft={setStartDraft} commitStart={commitStart}
          duration={duration} onDuration={(v) => { setDuration(v); touched(); }}
          angle={angle} onAngle={(v) => { setAngle(v); touched(); }}
          cps={cps} onCps={(v) => { setCps(v); touched(); }}
          ink={ink} onInk={(v) => { setInk(v); touched(); }}
          showInk={showInk} onToggleInk={() => setShowInk((s) => !s)} inkUnavailable={inkUnavailable} closed={closed}
          previewing={previewing}
          protectCount={protectedPolys.length} protecting={tool === "protect"} onProtect={() => setTool("protect")}
          plate={plate} plateUploading={plateUploading} onPlateUpload={onPlateUpload} onPlateClear={onPlateClear}
          title={title} onTitle={(v) => { setTitle(v); onInputChangeRef.current(); }} titlePlaceholder={DEFAULT_TITLE}
          target={targetGarment} onTarget={(v) => { setTargetGarment(v); onInputChangeRef.current(); }} targetPlaceholder={DEFAULT_TARGET}
        />
      )}
    </div>
  );
}
