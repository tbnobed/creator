import type { ComfyServer } from "@workspace/db";

type WorkflowWithMappings = {
  apiWorkflow: Record<string, unknown> | null;
  mappings: Record<string, { nodeId: string; input: string }>;
};

const hardwareTags = new Set(["a100", "blackwell"]);

export function hasRequiredTags(serverTags: string[], requiredTags: string[]): boolean {
  const normalizedServerTags = new Set(serverTags.map((tag) => tag.trim().toLowerCase()));
  const requiredHardware = requiredTags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => hardwareTags.has(tag));
  const serverHardware = [...normalizedServerTags].filter((tag) => hardwareTags.has(tag));
  // A hardware-specific workflow must not run on a worker whose registration
  // advertises no single hardware class. This prevents an old/broad tag set
  // from routing the Blackwell graph to an A100 (or the reverse).
  if (requiredHardware.length === 1 && serverHardware.length !== 1) return false;
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