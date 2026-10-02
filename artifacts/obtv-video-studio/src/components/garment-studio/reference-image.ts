/** Validate by decoding, then normalize to PNG. Extensions and browser MIME labels can be wrong. */
export async function prepareReferenceImage(file: File): Promise<File> {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("Choose a reference image smaller than 20 MB.");
  let image: ImageBitmap;
  try { image = await createImageBitmap(file); }
  catch { throw new Error("This file could not be decoded as an image. Export it as PNG or JPEG and upload it again."); }
  try {
    if (!image.width || !image.height || image.width * image.height > 24_000_000) {
      throw new Error("Choose a reference image with at most 24 megapixels.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not prepare the image.");
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve,reject)=>canvas.toBlob(
      value=>value ? resolve(value) : reject(new Error("Could not prepare this image.")), "image/png"));
    if (blob.size > 20 * 1024 * 1024) throw new Error("The decoded reference exceeds 20 MB. Reduce its dimensions.");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.png`, {type:"image/png"});
  } finally { image.close(); }
}