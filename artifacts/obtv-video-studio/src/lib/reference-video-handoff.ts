/** A local preview is not a server reference. Navigate only after upload succeeds. */
export async function handoffReferenceVideo(
  uploadedKey: string | null,
  upload: () => Promise<string | null>,
  navigate: (storageKey: string) => void,
): Promise<boolean> {
  const storageKey = uploadedKey || await upload();
  if (!storageKey) return false;
  navigate(storageKey);
  return true;
}
