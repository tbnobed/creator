/** Pure validation for the Preserve artwork (local pixel animation) workflow. No DOM, no network. */

export interface Pt { x: number; y: number }

export const PIXEL_MIN_SECONDS = 0.5;
export const PIXEL_MAX_SECONDS = 5;
export const POLY_MIN = 3;
export const POLY_MAX = 128;
export const MAX_PROTECTED = 8;
export const ANGLE_LIMIT = 35;
export const CPS_MIN = 0.2;
export const CPS_MAX = 2;
export const INK_MIN = 5;
export const INK_MAX = 100;

const inUnit = (p: Pt) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Shoelace area in normalized units (absolute). */
export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonProblem(poly: Pt[], label = "Selection"): string | null {
  if (poly.length < POLY_MIN) return `${label} needs at least ${POLY_MIN} points.`;
  if (poly.length > POLY_MAX) return `${label} can have at most ${POLY_MAX} points.`;
  if (!poly.every(inUnit)) return `${label} has points outside the frame.`;
  const area = polygonArea(poly);
  if (area <= 0.00002) return `${label} is too small to animate.`;
  if (area > 0.2) return `${label} covers too much of the frame (max 20%).`;
  return null;
}

export function pixelRangeProblem(start: number, duration: number, total: number | undefined): string | null {
  if (!total || !Number.isFinite(total) || total <= 0) return "Source duration is unknown.";
  if (!Number.isFinite(start) || start < 0) return "Start cannot be negative.";
  if (!Number.isFinite(duration) || duration < PIXEL_MIN_SECONDS) return `Clip must be at least ${PIXEL_MIN_SECONDS}s.`;
  if (duration > PIXEL_MAX_SECONDS) return `Clip is capped at ${PIXEL_MAX_SECONDS}s.`;
  if (start + duration > total + 1e-3) return `Window runs past the end (source is ${total.toFixed(2)}s).`;
  return null;
}

export function motionProblem(angle: number, cps: number, ink: number): string | null {
  if (!Number.isFinite(angle) || Math.abs(angle) < 1) return "Rotation angle must be at least 1°.";
  if (Math.abs(angle) > ANGLE_LIMIT) return `Rotation is limited to ±${ANGLE_LIMIT}°.`;
  if (!Number.isFinite(cps) || cps < CPS_MIN || cps > CPS_MAX) return `Speed must be ${CPS_MIN}–${CPS_MAX} cycles per second.`;
  if (!Number.isFinite(ink) || ink < INK_MIN || ink > INK_MAX) return `Ink threshold must be ${INK_MIN}–${INK_MAX}.`;
  return null;
}

export interface PixelBlockerInput {
  hasSource: boolean;
  polygon: Pt[];
  closed: boolean;
  pivot: Pt | null;
  protectedPolygons: Pt[][];
  /** Points in an unclosed protected-area draft (never submitted). */
  pendingProtectPoints?: number;
  start: number;
  duration: number;
  total: number | undefined;
  angle: number;
  cps: number;
  ink: number;
  reviewed: boolean;
  title: string;
  busy: boolean;
  activeJob: boolean;
}

export function pixelSubmitBlocker(i: PixelBlockerInput): string | null {
  if (!i.hasSource) return "Upload a source clip first.";
  if (i.busy) return "Wait for the current upload or request to finish.";
  if (i.activeJob) return "A job is still running.";
  const r = pixelRangeProblem(i.start, i.duration, i.total);
  if (r) return r;
  if (!i.closed) return "Close the moving-part outline.";
  const p = polygonProblem(i.polygon);
  if (p) return p;
  if (!i.pivot || !inUnit(i.pivot)) return "Place the pivot point.";
  if (i.pendingProtectPoints) return "Close or undo the open protected area.";
  if (i.protectedPolygons.length > MAX_PROTECTED) return `At most ${MAX_PROTECTED} protected areas.`;
  for (let k = 0; k < i.protectedPolygons.length; k++) {
    const q = polygonProblem(i.protectedPolygons[k], `Protected area ${k + 1}`);
    if (q) return q;
  }
  const m = motionProblem(i.angle, i.cps, i.ink);
  if (m) return m;
  if (!i.title.trim()) return "Add a short title.";
  if (!i.reviewed) return "Confirm you reviewed the selected frame.";
  return null;
}

const round = (v: number) => Math.round(v * 10000) / 10000;
export const roundPoly = (poly: Pt[]) => poly.map((p) => ({ x: round(clamp01(p.x)), y: round(clamp01(p.y)) }));
