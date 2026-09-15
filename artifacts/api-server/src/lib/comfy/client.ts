import { lookup } from "node:dns/promises";

export type PrivateComfyServer = {
  apiBaseUrl: string;
  websocketUrl: string;
  displayName: string;
};

type FetchOptions = RequestInit & { timeoutMs?: number };

export type ComfyUIRequestErrorKind = "configuration" | "network" | "http" | "invalid-response";

export class ComfyUIRequestError extends Error {
  constructor(
    message: string,
    readonly kind: ComfyUIRequestErrorKind,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "ComfyUIRequestError";
    this.status = options?.status;
  }

  readonly status?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientComfyUIRequestError(error: unknown): error is ComfyUIRequestError {
  return error instanceof ComfyUIRequestError
    && (
      error.kind === "network"
      || (error.kind === "http" && Boolean(error.status && (error.status >= 500 || error.status === 429 || error.status === 408)))
    );
}

type ComfyWebSocket = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
  close: () => void;
};

type ComfyWebSocketConstructor = new (url: string) => ComfyWebSocket;

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
    let baseUrl: URL;
    try {
      baseUrl = await assertTrustedComfyUrl(this.server.apiBaseUrl);
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI request configuration is invalid: ${errorMessage(error)}`,
        "configuration",
        { cause: error },
      );
    }
    const target = new URL(pathname, baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await fetch(target, { ...options, signal: controller.signal });
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI request to ${pathname} failed: ${errorMessage(error)}`,
        "network",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI response from ${pathname} was interrupted: ${errorMessage(error)}`,
        "network",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ComfyUIRequestError(
        `ComfyUI ${pathname} returned HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 500)}` : ""}`,
        "http",
        { status: response.status },
      );
    }
    if (!responseText) return undefined as T;
    try {
      return JSON.parse(responseText) as T;
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI ${pathname} returned invalid JSON`,
        "invalid-response",
        { cause: error },
      );
    }
  }

  getSystemStats() {
    return this.request<Record<string, unknown>>("/system_stats");
  }

  getQueue() {
    return this.request<{ queue_running?: unknown[]; queue_pending?: unknown[] }>("/queue");
  }

  async getHistory(promptId?: string): Promise<Record<string, unknown>> {
    const pathname = promptId
      ? `/history/${encodeURIComponent(promptId)}`
      : "/history";
    const history = await this.request<unknown>(pathname);
    if (!history || typeof history !== "object" || Array.isArray(history)) {
      throw new ComfyUIRequestError(`ComfyUI ${pathname} returned an invalid history object`, "invalid-response");
    }
    return history as Record<string, unknown>;
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

  async uploadAudio(file: { name: string; mimeType: "audio/wav"; bytes: Buffer }): Promise<{ name: string }> {
    const form = new FormData();
    const bytes = new Uint8Array(file.bytes);
    form.append("image", new Blob([bytes], { type: file.mimeType }), file.name);
    return this.request<{ name: string }>("/upload/image", { method: "POST", body: form, timeoutMs: 60_000 });
  }

  async getOutputFile(filename: string, subfolder = "", type = "output"): Promise<Buffer> {
    let baseUrl: URL;
    try {
      baseUrl = await assertTrustedComfyUrl(this.server.apiBaseUrl);
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI output request configuration is invalid: ${errorMessage(error)}`,
        "configuration",
        { cause: error },
      );
    }
    const target = new URL("/view", baseUrl);
    target.searchParams.set("filename", filename);
    target.searchParams.set("subfolder", subfolder);
    target.searchParams.set("type", type);
    let response: Response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI output retrieval failed: ${errorMessage(error)}`,
        "network",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ComfyUIRequestError(
        `ComfyUI output retrieval returned HTTP ${response.status}`,
        "http",
        { status: response.status },
      );
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new ComfyUIRequestError(
        `ComfyUI output transfer was interrupted: ${errorMessage(error)}`,
        "network",
        { cause: error },
      );
    }
  }

  submitWorkflow(workflow: Record<string, unknown>, clientId: string) {
    return this.request<{ prompt_id: string }>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      timeoutMs: 60_000,
    });
  }

  connectProgress(
    clientId: string,
    onMessage: (message: Record<string, unknown>) => void,
    onDisconnect?: () => void,
  ): () => void {
    const WebSocketConstructor = (globalThis as unknown as { WebSocket?: ComfyWebSocketConstructor }).WebSocket;
    if (!WebSocketConstructor) {
      throw new Error("This server runtime does not support ComfyUI progress WebSockets");
    }
    const target = new URL(this.server.websocketUrl);
    target.searchParams.set("clientId", clientId);
    const socket = new WebSocketConstructor(target.toString());
    let closed = false;
    let socketClosed = false;
    const closeSocket = () => {
      if (socketClosed) return;
      socketClosed = true;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // A WebSocket that failed during construction may reject close().
      }
    };
    const notifyDisconnect = () => {
      if (closed) return;
      closed = true;
      // Detach callbacks before notifying the observer. The observer closes
      // the disposer, which must never synchronously recurse through onclose.
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        onDisconnect?.();
      } finally {
        closeSocket();
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as unknown;
        if (message && typeof message === "object") {
          onMessage(message as Record<string, unknown>);
        }
      } catch {
        // Ignore non-JSON WebSocket frames from ComfyUI.
      }
    };
    socket.onerror = () => {
      // The normal HTTP monitor continues if a worker's WebSocket is unavailable.
      notifyDisconnect();
    };
    socket.onclose = () => {
      notifyDisconnect();
    };
    return () => {
      closed = true;
      closeSocket();
    };
  }

  removeQueuedPrompt(promptId: string) {
    return this.request<unknown>("/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  interrupt(promptId?: string) {
    return this.request<unknown>("/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: promptId ? JSON.stringify({ prompt_id: promptId }) : undefined,
    });
  }
}