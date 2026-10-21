import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mediaStorage } from "./storage-service";

const exec = promisify(execFile);
function xmlText(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, name) =>
    hex || dec ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex || dec, hex ? 16 : 10))) :
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase() as "amp"]));
}
export function extractFdx(buffer: Buffer): string {
  const xml = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<FinalDraft[\s>]/i.test(xml)) throw new Error("Provide a valid Final Draft document without external entities.");
  return [...xml.matchAll(/<Paragraph\b[^>]*>([\s\S]*?)<\/Paragraph>/gi)]
    .map(match => [...match[1].matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/gi)].map(text => xmlText(text[1])).join("")).filter(Boolean).join("\n\n");
}
export async function storeProductionScript(tenantId: string, name: string, bytes: Buffer) {
  const extension = path.extname(name).toLowerCase();
  if (![".txt", ".fdx", ".pdf"].includes(extension) || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Upload a TXT, FDX, or PDF script up to 10 MB.");
  let script: string;
  if (extension === ".fdx") script = extractFdx(bytes);
  else if (extension === ".txt") script = bytes.toString("utf8").replace(/^\uFEFF/, "");
  else {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF document.");
    const directory = await mkdtemp(path.join(tmpdir(), "production-script-"));
    try {
      await writeFile(path.join(directory, "input.pdf"), bytes);
      await exec("pdftotext", ["-layout", path.join(directory, "input.pdf"), path.join(directory, "script.txt")], { timeout: 30000, maxBuffer: 1024 * 1024 });
      script = await readFile(path.join(directory, "script.txt"), "utf8");
    } catch {
      throw new Error("PDF text could not be extracted. Use a text-based PDF, TXT, or FDX file. The server needs pdftotext installed.");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (!script.trim() || script.length > 100000 || script.includes("\u0000")) throw new Error("The script must contain readable text of at most 100,000 characters. Scanned PDFs need OCR first.");
  const storageKey = await mediaStorage.storeScript(name, bytes, tenantId);
  return { script: script.trim(), scriptName: path.basename(name).slice(0, 180), scriptStorageKey: storageKey };
}
