import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateWorkflowBody,
  CreateWorkflowResponse,
  GetWorkflowParams,
  GetWorkflowResponse,
  ListWorkflowsResponse,
  UpdateWorkflowBody,
  UpdateWorkflowParams,
  UpdateWorkflowResponse,
} from "@workspace/api-zod";
import { db, workflowTemplatesTable } from "@workspace/db";
import { parseApiWorkflow } from "../lib/comfy/workflow-parser";
import { presentWorkflow } from "../lib/studio-presenters";

const router: IRouter = Router();

function validateMappings(
  workflow: Record<string, unknown> | null,
  mappings: Record<string, { nodeId: string; input: string }>,
) {
  if (!workflow) {
    if (Object.keys(mappings).length) throw new Error("Import API-format workflow JSON before configuring mappings");
    return;
  }
  const { nodes } = parseApiWorkflow(workflow);
  for (const [field, mapping] of Object.entries(mappings)) {
    const node = nodes.find((item) => item.nodeId === mapping.nodeId);
    if (!node || !node.inputs.some((input) => input.name === mapping.input)) {
      throw new Error(`Mapping ${field} must target an existing node input`);
    }
  }
}

router.get("/workflows", async (_req, res): Promise<void> => {
  const workflows = await db.select().from(workflowTemplatesTable).orderBy(desc(workflowTemplatesTable.updatedAt));
  res.json(ListWorkflowsResponse.parse(workflows.map(presentWorkflow)));
});

router.post("/workflows", async (req, res): Promise<void> => {
  const input = CreateWorkflowBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  try {
    const parsed = parseApiWorkflow(input.data.apiWorkflow);
    const mappings = input.data.mappings ?? {};
    validateMappings(parsed.workflow, mappings);
    const [workflow] = await db.insert(workflowTemplatesTable).values({
      name: input.data.name,
      description: input.data.description,
      generationMode: input.data.generationMode,
      modelFamily: input.data.modelFamily,
      apiWorkflow: parsed.workflow,
      compatibleServerTags: input.data.compatibleServerTags,
      mappings,
      active: Object.keys(mappings).length > 0,
      expectedInputs: Object.keys(mappings),
      expectedOutputs: ["video"],
    }).returning();
    res.status(201).json(CreateWorkflowResponse.parse(presentWorkflow(workflow)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Workflow import failed" });
  }
});

router.get("/workflows/:id", async (req, res): Promise<void> => {
  const params = GetWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [workflow] = await db.select().from(workflowTemplatesTable).where(eq(workflowTemplatesTable.id, params.data.id));
  if (!workflow) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }
  res.json(GetWorkflowResponse.parse(presentWorkflow(workflow)));
});

router.patch("/workflows/:id", async (req, res): Promise<void> => {
  const params = UpdateWorkflowParams.safeParse(req.params);
  const input = UpdateWorkflowBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!input.success) {
    res.status(400).json({ error: input.error.message });
    return;
  }
  const [existing] = await db.select().from(workflowTemplatesTable).where(eq(workflowTemplatesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }
  try {
    const mappings = input.data.mappings ?? existing.mappings;
    validateMappings(existing.apiWorkflow, mappings);
    if (input.data.active && (!existing.apiWorkflow || Object.keys(mappings).length === 0)) {
      throw new Error("An active workflow needs imported API JSON and at least one mapping");
    }
    const [workflow] = await db.update(workflowTemplatesTable).set({
      name: input.data.name ?? existing.name,
      description: input.data.description ?? existing.description,
      compatibleServerTags: input.data.compatibleServerTags ?? existing.compatibleServerTags,
      active: input.data.active ?? existing.active,
      mappings,
      expectedInputs: Object.keys(mappings),
    }).where(eq(workflowTemplatesTable.id, existing.id)).returning();
    res.json(UpdateWorkflowResponse.parse(presentWorkflow(workflow)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Workflow update failed" });
  }
});

export default router;