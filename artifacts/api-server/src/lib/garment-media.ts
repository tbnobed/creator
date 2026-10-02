import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeVideoMediaProperties } from "./video-media-probe";

const execute = promisify(execFile);
export class GarmentError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function assertGarmentKey(key: string, tenantId: string, image = false) {
  const suffix = image ? "(jpg|png|webp)" : "(mp4|mov)";
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)
      || !new RegExp(`^tenants/${tenantId}/generation-references/[0-9a-f-]{36}\\.${suffix}$`, "i").test(key)) {
    throw new GarmentError(400, "Choose uploaded media belonging to this workspace.");
  }
}

export function garmentFrames(duration: number) {
  if (!Number.isFinite(duration) || duration < .5 || duration > 3) {
    throw new GarmentError(400, "Local garment drafts support a selected window from 0.5 to 3 seconds.");
  }
  return Math.ceil((duration * 16 - 1) / 4) * 4 + 1;
}

export function garmentScript(name: string) {
  let directory = process.cwd();
  for (let i = 0; i < 6; i++) {
    const file = path.join(directory, "scripts", name);
    if (existsSync(file)) return file;
    directory = path.dirname(directory);
  }
  throw new GarmentError(503, "Garment processing scripts are missing from this installation.");
}

export async function checkGarmentRuntime() {
  garmentScript("garment-reference.py");
  garmentScript("garment-print-proof.py");
  garmentScript("garment-proof.py");
  await execute("python", ["-c", "import cv2, numpy, PIL"], { timeout: 15_000, maxBuffer: 4096 });
  await execute("ffmpeg", ["-version"], { timeout: 10_000, maxBuffer: 16384 });
}

export async function prepareGarmentSource(bytes: Buffer, start: number, duration: number) {
  const properties = await probeVideoMediaProperties(bytes);
  const count = garmentFrames(duration);
  if (!Number.isFinite(start) || start < 0 || !properties.durationSeconds
      || start + duration > properties.durationSeconds + .001) {
    throw new GarmentError(400, "The selected range must be inside the source clip.");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "obtv-garment-prepare-"));
  try {
    await writeFile(path.join(dir, "source"), bytes);
    await execute("ffmpeg", [
      "-v", "error", "-nostdin", "-ss", String(start), "-i", path.join(dir, "source"),
      "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1",
      "-vf", `trim=duration=${duration},setpts=PTS-STARTPTS,fps=16,scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=0.3`,
      "-af", `atrim=duration=${duration},asetpts=PTS-STARTPTS`,
      "-frames:v", String(count), "-c:v", "libx264", "-crf", "18", "-c:a", "aac",
      "-movflags", "+faststart", "-y", path.join(dir, "prepared.mp4"),
    ], { timeout: 120_000, maxBuffer: 8192 });
    const result = await readFile(path.join(dir, "prepared.mp4"));
    return { bytes: result, frames: count, duration: count / 16 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function prepareGarmentReference(bytes: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "obtv-garment-reference-"));
  try {
    const input = path.join(dir, "reference"), output = path.join(dir, "reference.png");
    await writeFile(input, bytes);
    await execute("python", [garmentScript("garment-reference.py"), "--input", input, "--output", output],
      { timeout: 30_000, maxBuffer: 8192 });
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function buildGarmentGraph(input: {
  filename: string; prefix: string; prompt: string; seed: number;
  frames: number; reference?: string; mode: "replace-garment" | "animate-artwork"; targetGarment: string;
}): Promise<Record<string, unknown>> {
  const { stdout } = await execute("python", ["-c", [
    "import importlib.util,json,sys",
    "s=importlib.util.spec_from_file_location('garment',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
    "a=json.loads(sys.argv[2]);g=m.workflow(a['filename'],a['prefix'],a['prompt'],a['seed'],a.get('reference'),a['targetGarment'])",
    "g['16']['inputs']['length']=a['frames']",
    "g=m.artwork_workflow(a['filename'],a['prefix'],a['prompt'],a['seed'],a.get('reference'),a['frames'],a['targetGarment']) if a['mode']=='animate-artwork' else g",
    "print(json.dumps(g))",
  ].join(";"), garmentScript("garment-proof.py"), JSON.stringify(input)], { timeout: 15_000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}

export async function renderGarmentPrint(source: Buffer, mask: Buffer, signal?: AbortSignal) {
  const dir = await mkdtemp(path.join(tmpdir(), "obtv-garment-print-"));
  try {
    const input = path.join(dir, "source.mp4"), tracking = path.join(dir, "mask.mp4");
    const output = path.join(dir, "output.mp4");
    await Promise.all([writeFile(input, source), writeFile(tracking, mask)]);
    await execute("python", [garmentScript("garment-print-proof.py"), "--source", input,
      "--mask", tracking, "--output", output], { timeout: 120_000, maxBuffer: 8192, signal });
    const bytes = await readFile(output);
    const [before, after] = await Promise.all([probeVideoMediaProperties(source), probeVideoMediaProperties(bytes)]);
    if (before.width !== after.width || before.height !== after.height
        || Math.abs(before.durationSeconds - after.durationSeconds) > .1
        || (before.audioStreams ?? 0) !== (after.audioStreams ?? 0)) {
      throw new GarmentError(500, "Garment output changed timing, framing or audio. The original is safe.");
    }
    return bytes;
  } finally { await rm(dir, { recursive: true, force: true }); }
}