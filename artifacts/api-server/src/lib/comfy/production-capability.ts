import type { ParameterMappings } from "./workflow-builder";

/** A starting frame cannot consume one of the mandatory cast/location slots. */
export function productionWorkflowCapability(
  graph: Record<string, unknown> | null,
  mappings: ParameterMappings,
) {
  const frame = mappings.firstFrame;
  const node = frame && graph?.[frame.nodeId] as { inputs?: Record<string, unknown> } | undefined;
  const supportsFirstFrame = Boolean(frame && node?.inputs && frame.input in node.inputs);
  const referenceImageSlots = Object.entries(mappings).filter(([name, mapping]) =>
    /^referenceImage\d+$/.test(name)
    && !(frame && mapping.nodeId === frame.nodeId && mapping.input === frame.input),
  ).length;
  return { supportsFirstFrame, referenceImageSlots };
}
