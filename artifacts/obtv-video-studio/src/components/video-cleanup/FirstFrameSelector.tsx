import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Eraser, Shield, Undo2, X } from "lucide-react";
import { clientToNormalized, containedMediaRect, MAX_CLEANUP_POINTS, normalizedToBox } from "@/lib/video-cleanup";
import type { CleanupDraft, CleanupPointType } from "@/lib/video-cleanup";

export function FirstFrameSelector({ draft, locked, pointType, onAdd }: {
  draft: CleanupDraft; locked: boolean; pointType: CleanupPointType; onAdd: (p: { x: number; y: number; type: CleanupPointType }) => void;
}) {
  const source = draft.source!;
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = useMemo(() => containedMediaRect(box.w, box.h, source.width, source.height), [box, source.width, source.height]);

  function pinFirstFrame() {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    if (v.currentTime !== 0) v.currentTime = 0;
  }

  function handlePointer(e: PointerEvent<HTMLDivElement>) {
    if (locked || !rect || !boxRef.current) return;
    const b = boxRef.current.getBoundingClientRect();
    const n = clientToNormalized(e.clientX - b.left, e.clientY - b.top, rect);
    if (n) onAdd({ ...n, type: pointType });
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (locked) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      setCursor((c) => ({ x: Math.min(1, Math.max(0, +(c.x + dx).toFixed(4))), y: Math.min(1, Math.max(0, +(c.y + dy).toFixed(4))) }));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onAdd({ ...cursor, type: pointType });
    }
  }

  const cursorPos = rect ? normalizedToBox(cursor, rect) : null;

  return (
    <section aria-labelledby="frame-heading" className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="frame-heading" className="text-sm font-semibold">First frame</h2>
        <p className="text-xs text-muted-foreground">
          {locked ? "Selection locked." : `Tap to add a ${pointType === "positive" ? "remove" : "protect"} point. Keyboard: arrows move, Enter places.`}
        </p>
      </div>
      <div
        ref={boxRef}
        role="application"
        aria-label={`First frame point placement. ${draft.points.length} points placed.`}
        tabIndex={0}
        onPointerUp={handlePointer}
        onKeyDown={handleKey}
        className={`group relative h-[min(56dvh,560px)] w-full touch-manipulation select-none overflow-hidden rounded-lg bg-black/70 outline-none focus-visible:ring-2 focus-visible:ring-primary ${locked ? "cursor-not-allowed" : "cursor-crosshair"}`}
        data-testid="first-frame-canvas"
      >
        <video
          ref={videoRef}
          src={source.mediaUrl}
          muted
          playsInline
          preload="auto"
          onLoadedData={() => { pinFirstFrame(); setReady(true); }}
          onPlay={pinFirstFrame}
          onSeeked={() => { if (videoRef.current && videoRef.current.currentTime !== 0) pinFirstFrame(); }}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          aria-hidden="true"
        />
        {!ready && <Skeleton className="absolute inset-0 rounded-none" />}
        {rect && (
          <div aria-hidden="true" className="pointer-events-none absolute border border-white/10" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        )}
        {rect && draft.points.map((p, i) => {
          const pos = normalizedToBox(p, rect);
          const positive = p.type === "positive";
          return (
            <span
              key={`${i}-${p.x}-${p.y}`}
              aria-hidden="true"
              className={`pointer-events-none absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 font-mono text-[11px] font-bold shadow-md ${positive ? "border-white bg-primary text-primary-foreground" : "border-white bg-sky-600 text-white"}`}
              style={{ left: pos.left, top: pos.top }}
            >
              {i + 1}
            </span>
          );
        })}
        {cursorPos && !locked && (
          <span aria-hidden="true" className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-white/80 opacity-0 group-focus-visible:opacity-100"
            style={{ left: cursorPos.left, top: cursorPos.top }} />
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Numbered markers show where you clicked. They are not a segmentation preview; Bria computes the actual mask.</p>
    </section>
  );
}

export function PointPanel({ draft, locked, pointType, onPointType, onRemove, onUndo, onClear }: {
  draft: CleanupDraft; locked: boolean; pointType: CleanupPointType; onPointType: (t: CleanupPointType) => void;
  onRemove: (i: number) => void; onUndo: () => void; onClear: () => void;
}) {
  return (
    <section aria-labelledby="points-heading" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 id="points-heading" className="text-sm font-semibold">Points <span className="font-mono text-muted-foreground">{draft.points.length}/{MAX_CLEANUP_POINTS}</span></h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={onUndo} disabled={locked || !draft.points.length} aria-label="Undo last point" data-testid="button-undo-point"><Undo2 className="size-4" /></Button>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={locked || !draft.points.length} data-testid="button-clear-points">Clear</Button>
        </div>
      </div>
      <div role="radiogroup" aria-label="Point type" className="mt-3 grid grid-cols-2 gap-2">
        {([["positive", "Remove", Eraser, "Lights, stands, cables"], ["negative", "Protect", Shield, "People, props to keep"]] as const).map(([value, label, Icon, hint]) => (
          <button key={value} type="button" role="radio" aria-checked={pointType === value} disabled={locked} onClick={() => onPointType(value)}
            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${pointType === value ? (value === "positive" ? "border-primary bg-primary/10" : "border-sky-500 bg-sky-500/10") : "border-border hover:bg-secondary"}`}
            data-testid={`button-point-${value}`}>
            <span className="flex items-center gap-1.5 text-sm font-medium"><Icon className="size-3.5" />{label}</span>
            <span className="block text-[11px] text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
      {draft.points.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No points yet. Place one remove point on each light. Add protect points on people near the lights.
        </p>
      ) : (
        <ol className="mt-3 max-h-64 space-y-1 overflow-y-auto" aria-label="Placed points">
          {draft.points.map((p, i) => (
            <li key={`${i}-${p.x}-${p.y}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/60">
              <span className={`flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold ${p.type === "positive" ? "bg-primary text-primary-foreground" : "bg-sky-600 text-white"}`}>{i + 1}</span>
              <span className="flex-1">{p.type === "positive" ? "Remove" : "Protect"}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{Math.round(p.x * 100)}%, {Math.round(p.y * 100)}%</span>
              <Button variant="ghost" size="icon" className="size-7" disabled={locked} onClick={() => onRemove(i)} aria-label={`Remove point ${i + 1}`}><X className="size-3.5" /></Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
