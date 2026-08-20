export type ReadableWorkflowNode = {
  nodeId: string;
  classType: string;
  title: string | null;
  inputs: Array<{ name: string; value: unknown }>;
};

export function parseApiWorkflow(raw: unknown): {
  workflow: Record<string, unknown>;
  nodes: ReadableWorkflowNode[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Workflow must be a ComfyUI API-format JSON object");
  }
  const workflow = raw as Record<string, unknown>;
  const nodes = Object.entries(workflow).map(([nodeId, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Workflow node ${nodeId} is invalid`);
    }
    const node = value as Record<string, unknown>;
    const inputs = node.inputs;
    if (typeof node.class_type !== "string" || !inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      throw new Error(`Workflow node ${nodeId} must contain class_type and inputs`);
    }
    return {
      nodeId,
      classType: node.class_type,
      title: typeof node._meta === "object" && node._meta && typeof (node._meta as Record<string, unknown>).title === "string"
        ? (node._meta as Record<string, string>).title
        : null,
      inputs: Object.entries(inputs as Record<string, unknown>).map(([name, inputValue]) => ({
        name,
        value: inputValue,
      })),
    };
  });
  return { workflow, nodes };
}