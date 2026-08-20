import { lookup } from "node:dns/promises";

export type PrivateComfyServer = {
  apiBaseUrl: string;
  websocketUrl: string;
  displayName: string;
};

type FetchOptions = RequestInit & { timeoutMs?: number };

function isBlockedAddress(address: string): boolean {
  return (
    address === "169.254.169.254" ||
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("169.254.")
  );
}

export async function assertTrustedComfyUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid ComfyUI URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("ComfyUI URL must be an HTTP(S) URL without embedded credentials");
  }
  const allowedHosts = (process.env.COMFY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("This ComfyUI host is not on the administrator allowlist");
  }
  const result = await lookup(url.hostname, { all: true });
  if (result.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("This ComfyUI host resolves to a blocked network address");
  }
  return url;
}

export class ComfyUIClient {
  constructor(private readonly server: PrivateComfyServer) {}

  private async request<T>(pathname: string, options: FetchOptions = {}): Promise<T> {
    const baseUrl = await assertTrustedComfyUrl(this.server.apiBaseUrl);
    const target = new URL(pathname, baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(target, { ...options, signal: controller.signal });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`ComfyUI ${response.status}: ${message.slice(0, 500)}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getSystemStats() {
    return this.request<Record<string, unknown>>("/system_stats");
  }

  getQueue() {
    return this.request<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue");
  }

  getHistory(promptId: string) {
    return this.request<Record<string, unknown>>(`/history/${encodeURIComponent(promptId)}`);
  }

  getModels(folder: string) {
    return this.request<unknown[]>(`/models/${encodeURIComponent(folder)}`);
  }

  async uploadImage(file: { name: string; mimeType: string; bytes: Buffer }): Promise<{ name: string }> {
    const form = new FormData();
    const bytes = new Uint8Array(file.bytes);
    form.append("image", new Blob([bytes], { type: file.mimeType }), file.name);
    return this.request<{ name: string }>("/upload/image", { method: "POST", body: form, timeoutMs: 60_000 });
  }

  async uploadVideo(file: { name: string; mimeType: "video/mp4" | "video/webm"; bytes: Buffer }): Promise<{ name: string }> {
    const form = new FormData();
    const bytes = new Uint8Array(file.bytes);
    // ComfyUI stores user-provided input files through its upload/image endpoint,
    // including videos consumed by video-loader nodes.
    form.append("image", new Blob([bytes], { type: file.mimeType }), file.name);
    return this.request<{ name: string }>("/upload/image", { method: "POST", body: form, timeoutMs: 120_000 });
  }

  async getOutputFile(filename: string, subfolder = "", type = "output"): Promise<Buffer> {
    const baseUrl = await assertTrustedComfyUrl(this.server.apiBaseUrl);
    const target = new URL("/view", baseUrl);
    target.searchParams.set("filename", filename);
    target.searchParams.set("subfolder", subfolder);
    target.searchParams.set("type", type);
    const response = await fetch(target, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`ComfyUI output retrieval failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  submitWorkflow(workflow: Record<string, unknown>, clientId: string) {
    return this.request<{ prompt_id: string }>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      timeoutMs: 60_000,
    });
  }

  interrupt() {
    return this.request<unknown>("/interrupt", { method: "POST" });
  }
}