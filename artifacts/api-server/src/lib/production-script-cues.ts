// Reserved screenplay direction labels, not speaking/visible identities.
// Narrator and voice-over are deliberately not included: they may be real roles.
const directionLabels = new Set([
  "SFX", "FX", "SOUND", "SOUNDEFFECT", "SOUNDEFFECTS",
  "MUSIC", "SCORE", "AMBIENCE", "AMBIENTSOUND", "AUDIO",
  "VFX", "CAMERA", "ACTION", "CUTTO", "FADEIN", "FADEOUT",
  "TITLE", "TITLES", "CAPTION", "CAPTIONS", "ONSCREENTEXT",
  "SUPER", "TRANSITION", "BROLL",
]);

export function isProductionDirectionLabel(value: string): boolean {
  const label = value.normalize("NFKC").trim().replace(/^\[|\]$/g, "")
    .split(":")[0].replace(/\s*\([^)]*\)\s*$/, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "");
  return directionLabels.has(label);
}
