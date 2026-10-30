type Capability = {
  referenceImageSlots?: number;
  supportsReferenceVideo: boolean;
  requiresSettingReference: boolean;
};

export function localImageReferenceLimit(capabilities: Capability[], hasVideo: boolean, hasSetting: boolean): number {
  return Math.max(0, ...capabilities
    .filter(cap => cap.supportsReferenceVideo === hasVideo && (!cap.requiresSettingReference || hasSetting))
    .map(cap => cap.referenceImageSlots ?? 0));
}

export function localImageReferenceError(count: number, limit: number, uploading: boolean): string | null {
  if (uploading) return "Wait for the reference image upload to finish.";
  if (count > 0 && !limit) return "The selected local workflow does not accept reference images. Choose a compatible workflow or remove the images.";
  if (count > limit) return `The selected local workflow accepts at most ${limit} direct reference images. Remove extra images before rendering.`;
  return null;
}
