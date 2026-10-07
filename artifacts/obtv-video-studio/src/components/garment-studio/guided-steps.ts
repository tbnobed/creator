/** Pure guided-flow logic for Preserve artwork. No DOM, no network. */
import { ANGLE_LIMIT, CPS_MAX, CPS_MIN } from "./pixel-validation.ts";

export type PresetId = "gentle" | "normal" | "lively";
export interface MotionPreset { id: PresetId; label: string; angle: number; cps: number; hint: string }

/** Each preset is only a bounded back-and-forth rotation; values sit inside the validated limits. */
export const MOTION_PRESETS: readonly MotionPreset[] = [
  { id: "gentle", label: "Gentle", angle: 8, cps: 0.5, hint: "Small, slow sway" },
  { id: "normal", label: "Normal", angle: 14, cps: 0.8, hint: "Clear, steady swing" },
  { id: "lively", label: "Lively", angle: 24, cps: 1.4, hint: "Wider, faster swing" },
].map((p) => ({ ...p, angle: Math.min(ANGLE_LIMIT, p.angle), cps: Math.min(CPS_MAX, Math.max(CPS_MIN, p.cps)) })) as MotionPreset[];

export const DEFAULT_PRESET: PresetId = "normal";

/** Returns the matching preset id, or null when values were tuned manually. */
export function presetFor(angle: number, cps: number): PresetId | null {
  return MOTION_PRESETS.find((p) => p.angle === angle && p.cps === cps)?.id ?? null;
}

export const DEFAULT_TITLE = "Animated artwork";
export const DEFAULT_TARGET = "visible artwork";
export const effectiveTitle = (t: string) => t.trim() || DEFAULT_TITLE;
export const effectiveTarget = (t: string) => t.trim() || DEFAULT_TARGET;

export type GuidedStep = 1 | 2 | 3;
export type GuidedTool = "outline" | "pivot";
export interface GuideInput { hasSource: boolean; frameReady: boolean; points: number; closed: boolean; hasPivot: boolean; reviewed: boolean }
export interface GuideState { step: GuidedStep; tool: GuidedTool | null; action: string; detail: string }

export function guide(i: GuideInput): GuideState {
  if (!i.hasSource) return { step: 1, tool: null, action: "Choose a video", detail: "Upload a short clip where the artwork is clearly visible." };
  if (!i.frameReady) return { step: 2, tool: null, action: "Loading the frame", detail: "One moment while we grab a still from your video." };
  if (!i.closed) {
    if (i.points < 3) return { step: 2, tool: "outline", action: "Click around the part that should move", detail: `Place dots around its edge. ${i.points ? `${i.points} placed, ${3 - i.points} more minimum.` : "At least 3 dots."}` };
    return { step: 2, tool: "outline", action: "Finish the selection", detail: "Keep adding dots, then press Finish selection or click the first dot." };
  }
  if (!i.hasPivot) return { step: 2, tool: "pivot", action: "Click where the part is attached", detail: "The part will swing around this spot, like an arm at its shoulder or a flag at its pole." };
  if (!i.reviewed) return { step: 3, tool: null, action: "Preview, then confirm it looks right", detail: "Pick a motion level and watch the sketch." };
  return { step: 3, tool: null, action: "Create the video", detail: "Renders on our local machine. No charges." };
}
