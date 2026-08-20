import { parseApiWorkflow } from "./workflow-parser";

export type ParameterMappings = Record<string, { nodeId: string; input: string }>;

type WorkflowNode = {
  class_type?: unknown;
  inputs?: Record<string, unknown>;
};

function isNodeLink(value: unknown, nodeId: string): boolean {
  return Array.isArray(value) && value.length >= 2 && value[0] === nodeId;
}

function removeUnusedReferenceImageNodes(
  workflow: Record<string, WorkflowNode>,
  mappings: ParameterMappings,
  parameters: Record<string, string | number | undefined>,
): void {
  for (const [field, mapping] of Object.entries(mappings)) {
    if (!/^referenceImage\d+$/.test(field) || parameters[field] !== undefined) continue;

    const mappedNode = workflow[mapping.nodeId];
    if (!mappedNode?.inputs) continue;

    if (mappedNode.class_type !== "LoadImage") {
      delete mappedNode.inputs[mapping.input];
      continue;
    }

    delete workflow[mapping.nodeId];
    for (const node of Object.values(workflow)) {
      if (!node.inputs) continue;
      for (const [inputName, value] of Object.entries(node.inputs)) {
        if (isNodeLink(value, mapping.nodeId)) {
          delete node.inputs[inputName];
        }
      }
    }
  }
}

export function buildWorkflow(
  masterWorkflow: Record<string, unknown>,
  mappings: ParameterMappings,
  parameters: Record<string, string | number | undefined>,
): Record<string, unknown> {
  const { workflow } = parseApiWorkflow(masterWorkflow);
  const clone = structuredClone(workflow) as Record<string, WorkflowNode>;
  removeUnusedReferenceImageNodes(clone, mappings, parameters);
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