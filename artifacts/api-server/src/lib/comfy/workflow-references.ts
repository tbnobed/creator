import type { ParameterMappings } from "./workflow-builder";

type Node = { class_type?: unknown; inputs?: Record<string, unknown> };

function optionalImageInput(node: Node, input: string): boolean {
  // H3 declares this dynamic family optional with min=0, and executes with
  // an empty reference list. Do not infer this for arbitrary I2V nodes.
  return node.class_type === "MiniMaxH3ReferenceToVideo"
    && /^ref_images\.ref_image_\d+$/.test(input);
}

function optionalImageMapping(
  workflow: Record<string, Node>,
  mapping: { nodeId: string; input: string },
): boolean {
  const mapped = workflow[mapping.nodeId];
  if (!mapped?.inputs) return false;
  if (optionalImageInput(mapped, mapping.input)) return true;
  if (mapped.class_type !== "LoadImage" || mapping.input !== "image") return false;

  const consumers = Object.values(workflow).flatMap((node) =>
    Object.entries(node.inputs ?? {}).flatMap(([input, value]) =>
      Array.isArray(value) && value[0] === mapping.nodeId
        ? [{ node, input, output: value[1] }]
        : [],
    ),
  );
  return consumers.length > 0 && consumers.every(
    ({ node, input, output }) => output === 0 && optionalImageInput(node, input),
  );
}

/** Reference support does not imply a mandatory reference input. */
export function getWorkflowReferenceRequirements(
  apiWorkflow: Record<string, unknown> | null,
  mappings: ParameterMappings,
): { requiresCharacterReferences: boolean; requiresSettingReference: boolean } {
  const workflow = (apiWorkflow ?? {}) as Record<string, Node>;
  const requiresImage = (pattern: RegExp) => Object.entries(mappings).some(
    ([field, mapping]) => pattern.test(field) && !optionalImageMapping(workflow, mapping),
  );
  return {
    requiresCharacterReferences: requiresImage(/^referenceImage\d+$/),
    requiresSettingReference: requiresImage(/^settingImage\d+$/),
  };
}