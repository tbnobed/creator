import type { ComfyServer } from "@workspace/db";

type WorkflowWithMappings = {
  apiWorkflow: Record<string, unknown> | null;
  mappings: Record<string, { nodeId: string; input: string }>;
};

export function hasRequiredTags(serverTags: string[], requiredTags: string[]): boolean {
  const normalizedServerTags = new Set(serverTags.map((tag) => tag.trim().toLowerCase()));
  return requiredTags.every((tag) => normalizedServerTags.has(tag.trim().toLowerCase()));
}

export function isLongFormWorkflow(workflow: WorkflowWithMappings): boolean {
  return Boolean(workflow.apiWorkflow) &&
    !workflow.mappings.referenceVideo &&
    Object.keys(workflow.mappings).some((field) => /^referenceImage\d+$/.test(field));
}

export function selectServer(
  servers: ComfyServer[],
  requiredTags: string[],
): ComfyServer | null {
  const candidates = servers.filter((server) => {
    if (!server.enabled || server.status !== "ONLINE") return false;
    if (server.activeJobCount >= (server.maxConcurrentJobs ?? 1)) return false;
    return hasRequiredTags(server.tags, requiredTags);
  });
  return candidates.sort(
    (a, b) =>
      a.queueSize - b.queueSize ||
      a.activeJobCount - b.activeJobCount ||
      a.priority - b.priority,
  )[0] ?? null;
}