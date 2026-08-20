import type { ComfyServer } from "@workspace/db";

export function selectServer(
  servers: ComfyServer[],
  requiredTags: string[],
): ComfyServer | null {
  const candidates = servers.filter((server) => {
    if (!server.enabled || server.status !== "ONLINE") return false;
    if (server.maxConcurrentJobs && server.activeJobCount >= server.maxConcurrentJobs) return false;
    return requiredTags.every((tag) => server.tags.includes(tag));
  });
  return candidates.sort(
    (a, b) =>
      a.queueSize - b.queueSize ||
      a.activeJobCount - b.activeJobCount ||
      a.priority - b.priority,
  )[0] ?? null;
}