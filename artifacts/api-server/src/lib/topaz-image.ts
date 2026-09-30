import { spawn } from "node:child_process";

export const TOPAZ_IMAGE_MODEL = "cloud-topaz-upscale";
let opacityChecks = 0;

export function topazImageCost(width: number, height: number): number {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 32768)
    || width * height > 96_000_000) {
    throw new Error("Topaz image output must fit within 96 megapixels and 32768 pixels per edge.");
  }
  return width * height <= 24_000_000 ? 0.08 : width * height <= 48_000_000 ? 0.16 : 0.32;
}

export function topazImageScale(source: { width: number; height: number }, width: number, height: number): number {
  topazImageCost(width, height);
  const scale = width / source.width;
  if (![2, 4].includes(scale) || height !== source.height * scale) {
    throw new Error("Topaz images require an exact 2× or 4× upscale without cropping.");
  }
  return scale;
}

/** Decode actual pixels: an alpha channel is fine when every pixel is opaque. */
export async function assertOpaqueTopazSource(bytes: Buffer, mimeType: string): Promise<void> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !bytes.length || bytes.length > 12 * 1024 * 1024) {
    throw new Error("Topaz requires a PNG, JPEG or WebP source no larger than 12 MB.");
  }
  if (opacityChecks >= 2) throw new Error("Image validation is busy. Try again shortly; no Topaz request was submitted.");
  opacityChecks += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      // Smallest upscale is 2x: a 96 MP output permits at most 24 MP source.
      // Preserve native alpha depth (8->16 bit swscale expansion isn't exact).
      // Near-opaque 16-bit PNG pixels must not round to opaque.
      const sixteenBit = mimeType === "image/png" && bytes[24] === 16;
      const bytesPerPixel = sixteenBit ? 2 : 1;
      const maxOutput = 24_000_000 * bytesPerPixel;
      const child = spawn("ffmpeg", [
        "-v", "error", "-max_alloc", "268435456", "-threads", "1",
        "-max_pixels", "24000000", "-i", "pipe:0", "-frames:v", "1",
        "-filter_threads", "1", "-vf", `format=${sixteenBit ? "rgba64le" : "rgba"},alphaextract`,
        "-pix_fmt", sixteenBit ? "gray16le" : "gray", "-f", "rawvideo", "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let total = 0;
      let opaque = true;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxOutput) child.kill("SIGKILL");
        if (opaque) opaque = chunk.every((value) => value === 255);
      });
      child.stderr.resume();
      child.stdin.on("error", () => { /* Decoder exit is handled below. */ });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Image opacity validation could not start. No Topaz request was submitted."));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut || code !== 0 || !total || total > maxOutput || total % bytesPerPixel !== 0) {
          reject(new Error("Could not validate image pixels within the supported source limits. No Topaz request was submitted."));
        } else if (!opaque) {
          reject(new Error("Topaz image upscaling does not guarantee transparency. Export an opaque image first."));
        } else resolve();
      });
      child.stdin.end(bytes);
    });
  } finally {
    opacityChecks -= 1;
  }
}