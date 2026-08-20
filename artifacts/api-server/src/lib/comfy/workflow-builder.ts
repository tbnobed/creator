import { parseApiWorkflow } from "./workflow-parser";

export type ParameterMappings = Record<string, { nodeId: string; input: string }>;

export function buildWorkflow(
  masterWorkflow: Record<string, unknown>,
  mappings: ParameterMappings,
  parameters: Record<string, string | number | undefined>,
): Record<string, unknown> {
  const { workflow } = parseApiWorkflow(masterWorkflow);
  const clone = structuredClone(workflow) as Record<string, { inputs?: Record<string, unknown> }>;
  for (const [field, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    const mapping = mappings[field];
    if (!mapping) continue;
    const node = clone[mapping.nodeId];
    if (!node?.inputs || !(mapping.input in node.inputs)) {
      throw new Error(`Workflow mapping for ${field} does not match the imported API workflow`);
    }
    node.inputs[mapping.input] = value;
  }
  return clone;
}