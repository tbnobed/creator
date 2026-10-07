import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GarmentJob as ApiGarmentJob } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ResultPanel } from "./GarmentWorkbench";
import { isActiveJob } from "./validation";
import type { GarmentReference, GarmentSource } from "./types";
import {
  ANGLE_LIMIT, CPS_MAX, CPS_MIN, INK_MAX, INK_MIN, MAX_PROTECTED, PIXEL_MAX_SECONDS, PIXEL_MIN_SECONDS, POLY_MAX,
  clamp01, pixelSubmitBlocker, roundPoly,
} from "./pixel-validation";
import type { Pt } from "./pixel-validation";
import {
  AlertTriangle, Check, Crosshair, Eye, EyeOff, ImagePlus, Loader2, Lock, Pause, Pentagon, Play, Recycle, RotateCcw, ShieldCheck, Trash2, Undo2, Upload, X,
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
}

type Tool = "outline" | "pivot" | "protect";
const MAX_CANVAS = 1280;

function tracePath(ctx: CanvasRenderingContext2D, poly: Pt[], w: number, h: number, close: boolean) {
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
  if (close) ctx.closePath();
}

export function PreserveArtworkWorkbench({
  source, job, loading, error, onUpload, onSubmit, onCancel, plate, plateUploading, onPlateUpload, onPlateClear, onUseResult, usingResult, onInputChange, anyActiveJob = false,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const plateInput = useRef<HTMLInputElement>(null);
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
  const busy = loading || plateUploading || usingResult;
  const blocker = pixelSubmitBlocker({
    hasSource: Boolean(source) && frameState === "ready", polygon, closed, pivot, protectedPolygons: protectedPolys,
    pendingProtectPoints: draftProtect.length,
    start, duration, total, angle, cps, ink, reviewed, title, busy, activeJob: active || anyActiveJob,
  });
  const canUseResult = job && job.status === "succeeded" && Boolean(job.outputUrl) && !active && !anyActiveJob;

  function submit() {
    if (blocker || !pivot) return;
    onSubmit({
      prompt: title.trim(),
      targetGarment: targetGarment.trim() || "printed artwork",
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
    ? polygon.length ? `Outline open: ${polygon.length} point${polygon.length === 1 ? "" : "s"}` : "No outline yet"
    : `Outline closed: ${polygon.length} points`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="preserve-workbench">
      <div className="min-w-0 space-y-6">
        <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-relaxed" data-testid="text-preserve-explainer">
          <Lock className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold">Preserve artwork moves your original print pixels; nothing is redrawn by AI.</span>{" "}
            You outline one rigid part of the print and it swings around a pivot within a bounded angle. Local optical flow follows visible cloth motion, but cannot reliably reconstruct hidden artwork:
            choose a stretch where the artwork stays fully visible, flat, and away from folds and hands. Gaps uncovered by the motion are filled by
            local cloth inpainting, which can smear on patterned fabric; an optional clean-cloth plate gives the best restoration.
            Runs locally on the server and never incurs provider charges.
          </p>
        </div>

        {!source ? (
          <section aria-labelledby="preserve-upload-heading"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onUpload(f); }}
            className="rounded-xl border-2 border-dashed border-border bg-card p-8 text-center md:p-14">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
              {loading ? <Loader2 className="size-6 animate-spin text-primary" /> : <Upload className="size-6 text-primary" />}
            </div>
            <h2 id="preserve-upload-heading" className="mt-4 text-lg font-semibold">{loading ? "Uploading clip" : "Drop a clip with the printed artwork"}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">MP4 or MOV. You render a window of up to {PIXEL_MAX_SECONDS} seconds; output is normalized to at most 720p.</p>
            <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="sr-only" aria-label="Choose source video"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onUpload(f); }} />
            <Button className="mt-5" disabled={loading} onClick={() => fileInput.current?.click()} data-testid="button-preserve-upload">Choose clip</Button>
          </section>
        ) : (
          <section aria-labelledby="preserve-editor-heading" className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="preserve-editor-heading" className="text-sm font-semibold">Frame at {start.toFixed(2)}s</h2>
              <span className="font-mono text-xs text-muted-foreground">{source.width}x{source.height} / {source.durationSeconds.toFixed(2)}s</span>
            </div>

            <div role="radiogroup" aria-label="Editing tool" className="mb-3 flex flex-wrap gap-1.5">
              {([
                ["outline", "Moving part", Pentagon],
                ["pivot", "Pivot", Crosshair],
                ["protect", "Protect", ShieldCheck],
              ] as const).map(([value, label, Icon]) => (
                <button key={value} type="button" role="radio" aria-checked={tool === value} disabled={previewing}
                  onClick={() => setTool(value)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${tool === value ? "border-primary bg-primary/15 text-primary" : "border-border hover:bg-secondary"}`}
                  data-testid={`button-tool-${value}`}>
                  <Icon className="size-3.5" />{label}
                </button>
              ))}
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
                aria-label={`Still frame editor. Tool: ${tool}. ${selectionStatus}. ${pivot ? "Pivot placed." : "No pivot."} Arrow keys move the cursor (Shift for larger steps), Enter places a point, Backspace undoes.`}
                aria-describedby="preserve-cursor-readout"
                className={`block h-auto w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-primary ${previewing ? "cursor-default" : "cursor-crosshair"}`}
                data-testid="canvas-preserve-editor" />
              {frameState !== "ready" && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground" data-testid="status-preserve-frame">
                  {frameState === "error" ? <span className="flex items-center gap-1.5 text-destructive"><AlertTriangle className="size-3.5" />Could not read this frame.</span>
                    : <span className="flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />Seeking to {start.toFixed(2)}s</span>}
                </div>
              )}
              {previewing && (
                <span className="absolute left-2 top-2 rounded-md bg-background/85 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-primary" data-testid="badge-outline-preview">
                  Outline preview / approximation / no tracking
                </span>
              )}
            </div>
              <video ref={videoRef} src={source.mediaUrl} muted playsInline preload="auto" className="hidden" aria-hidden="true" />
            </div>
            <p id="preserve-cursor-readout" className="mt-1 font-mono text-[10px] text-muted-foreground" aria-live="polite" data-testid="text-cursor-readout">
              Keyboard cursor x {cursor.x.toFixed(3)} / y {cursor.y.toFixed(3)}
            </p>

            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-tool-help">
              {tool === "outline" && (closed ? "Outline closed. Undo reopens it." : "Click or tap around the part that should move. Click the first point (or Close) to finish.")}
              {tool === "pivot" && "Click the hinge point the part rotates around, e.g. a shoulder or wrist joint in the print."}
              {tool === "protect" && `Outline buttons, seams or text that must never move (max ${MAX_PROTECTED}). Click the first point to close each.`}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-auto font-mono text-[11px] text-muted-foreground" data-testid="text-selection-status" aria-live="polite">
                {selectionStatus} / {pivot ? "pivot set" : "no pivot"} / {protectedPolys.length} protected
              </span>
              <Button variant="ghost" size="sm" onClick={undo} disabled={previewing} data-testid="button-preserve-undo"><Undo2 className="size-3.5" />Undo</Button>
              {tool === "outline" && !closed && (
                <Button variant="secondary" size="sm" disabled={polygon.length < 3 || previewing} onClick={() => { setClosed(true); touched(); }} data-testid="button-preserve-close">
                  <Check className="size-3.5" />Close outline
                </Button>
              )}
              {tool === "protect" && draftProtect.length > 0 && (
                <Button variant="secondary" size="sm" disabled={draftProtect.length < 3} onClick={closeProtect} data-testid="button-protect-close"><Check className="size-3.5" />Close area</Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => { resetSelection(); onInputChangeRef.current(); }} data-testid="button-preserve-reset"><Trash2 className="size-3.5" />Reset all</Button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button size="sm" variant={previewing ? "secondary" : "default"} disabled={!closed || !pivot || frameState !== "ready"}
                onClick={() => setPreviewing((p) => !p)} data-testid="button-outline-preview">
                {previewing ? <><Pause className="size-3.5" />Stop outline preview</> : <><Play className="size-3.5" />Outline motion preview</>}
              </Button>
              <Button size="sm" variant="ghost" disabled={!closed || previewing || inkUnavailable} onClick={() => setShowInk((s) => !s)} aria-pressed={showInk} data-testid="button-toggle-ink">
                {showInk ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{showInk ? "Hide ink" : "Show ink"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Preview rotates the selected still pixels only. It is not the final fabric result; Render saves a real clip.
              </span>
            </div>
            {inkUnavailable && <p className="mt-2 text-[11px] text-muted-foreground">Ink highlight is unavailable for this media in the browser; the server still applies the threshold.</p>}

            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="sm" disabled={loading || active} onClick={() => fileInput.current?.click()} data-testid="button-preserve-replace"><Upload className="size-3.5" />Use a different clip</Button>
              <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="sr-only" aria-label="Replace source video"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onUpload(f); }} />
            </div>
          </section>
        )}

        <ResultPanel job={job} sourceUrl={job?.sourceUrl ?? source?.mediaUrl ?? undefined} start={job?.sourceUrl ? 0 : start} onCancel={onCancel} />
        {canUseResult && job && (
          <div className="-mt-3 flex justify-end">
            <Button variant="secondary" size="sm" disabled={busy || active} onClick={() => onUseResult(job.id)} data-testid="button-use-result-source">
              {usingResult ? <Loader2 className="size-3.5 animate-spin" /> : <Recycle className="size-3.5" />}Use result as source
            </Button>
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <section aria-labelledby="preserve-window-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="preserve-window-heading" className="text-sm font-semibold">Window</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-xs">
              <span className="text-muted-foreground">Start (s)</span>
              <input type="number" min={0} step={0.05} value={startDraft} disabled={!source || previewing}
                onChange={(e) => setStartDraft(e.target.value)}
                onBlur={(e) => commitStart(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitStart((e.target as HTMLInputElement).value); }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm" data-testid="input-preserve-start" />
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground">Length (s)</span>
              <input type="number" min={PIXEL_MIN_SECONDS} max={PIXEL_MAX_SECONDS} step={0.1} value={duration} disabled={!source}
                onChange={(e) => { setDuration(Number(e.target.value)); onInputChangeRef.current(); }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm" data-testid="input-preserve-duration" />
            </label>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Changing the start loads a new frame and clears the outline, pivot, protected areas and plate.</p>
        </section>

        <section aria-labelledby="preserve-motion-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="preserve-motion-heading" className="text-sm font-semibold">Motion</h2>
          <Slider label="Swing angle" value={angle} min={-ANGLE_LIMIT} max={ANGLE_LIMIT} step={1} unit="°" onChange={(v) => { setAngle(v); onInputChangeRef.current(); }} testId="slider-angle" />
          <Slider label="Speed" value={cps} min={CPS_MIN} max={CPS_MAX} step={0.1} unit=" cycles/s" onChange={(v) => { setCps(v); onInputChangeRef.current(); }} testId="slider-cps" />
          <Slider label="Ink threshold" value={ink} min={INK_MIN} max={INK_MAX} step={1} unit="" onChange={(v) => { setInk(v); onInputChangeRef.current(); }} testId="slider-ink" />
          <p className="mt-2 text-[11px] text-muted-foreground">Rotation is a bounded back-and-forth swing. It cannot follow text instructions or perform actions. Raise the threshold if cloth texture is highlighted as ink.</p>
        </section>

        <section aria-labelledby="preserve-plate-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="preserve-plate-heading" className="text-sm font-semibold">Clean-cloth plate <span className="font-normal text-muted-foreground">(optional)</span></h2>
          <p className="mt-1 text-[11px] text-muted-foreground">A full-frame image of the same shot at {start.toFixed(2)}s with the artwork removed. Must match the source aspect ratio.</p>
          {plate ? (
            <div className="mt-3 flex items-center gap-3">
              <img src={plate.mediaUrl} alt="Uploaded clean plate" className="h-12 w-20 rounded object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs" data-testid="text-plate-name">{plate.name}</span>
              <Button variant="ghost" size="icon" aria-label="Remove clean plate" onClick={onPlateClear} data-testid="button-plate-clear"><X className="size-4" /></Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" className="mt-3" disabled={!source || plateUploading} onClick={() => plateInput.current?.click()} data-testid="button-plate-upload">
              {plateUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}Upload plate
            </Button>
          )}
          <input ref={plateInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose clean plate image"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPlateUpload(f); }} />
        </section>

        <section aria-labelledby="preserve-render-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="preserve-render-heading" className="text-sm font-semibold">Render</h2>
          <label className="mt-3 block text-xs">
            <span className="text-muted-foreground">Title</span>
            <input value={title} maxLength={120} onChange={(e) => { setTitle(e.target.value); onInputChangeRef.current(); }} placeholder="Left arm of jacket mascot swings"
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" data-testid="input-preserve-title" />
          </label>
          <label className="mt-3 block text-xs">
            <span className="text-muted-foreground">Target / artwork note</span>
            <input value={targetGarment} maxLength={160} onChange={(e) => { setTargetGarment(e.target.value); onInputChangeRef.current(); }} placeholder="e.g. printed artwork on a jacket, bag, or vehicle"
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" data-testid="input-preserve-target" />
          </label>
          <label className="mt-4 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={reviewed} disabled={!closed || !pivot} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5 accent-[hsl(var(--primary))]" data-testid="checkbox-preserve-reviewed" />
            <span>I reviewed the frame: the artwork is fully visible, the outline and pivot are correct, and protected areas are covered.</span>
          </label>
          {error && <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs" data-testid="text-preserve-error">{error}</p>}
          <Button className="mt-4 w-full" disabled={Boolean(blocker)} onClick={submit} data-testid="button-preserve-render">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}Render preserved clip
          </Button>
          {blocker && <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-preserve-blocker">{blocker}</p>}
          <p className="mt-2 text-[11px] text-muted-foreground">Local render, no provider charges. The saved clip appears in history and survives reloads.</p>
        </section>
      </aside>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; testId: string }) {
  return (
    <label className="mt-3 block text-xs">
      <span className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="font-mono">{value}{unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[hsl(var(--primary))]" data-testid={testId} />
    </label>
  );
}
