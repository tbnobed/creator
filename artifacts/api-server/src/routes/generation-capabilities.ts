import { and, desc, eq, isNotNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetGenerationCapabilitiesResponse } from "@workspace/api-zod";
import { db, workflowTemplatesTable } from "@workspace/db";
import { getWorkflowReferenceRequirements } from "../lib/comfy/workflow-references";

const router: IRouter = Router();

router.get("/generation-capabilities", async (_req, res): Promise<void> => {
  const workflows = await db.select({
    id: workflowTemplatesTable.id,
    name: workflowTemplatesTable.name,
    generationMode: workflowTemplatesTable.generationMode,
    modelFamily: workflowTemplatesTable.modelFamily,
    mappings: workflowTemplatesTable.mappings,
    apiWorkflow: workflowTemplatesTable.apiWorkflow,
  }).from(workflowTemplatesTable).where(and(
    eq(workflowTemplatesTable.active, true),
    isNotNull(workflowTemplatesTable.apiWorkflow),
  )).orderBy(desc(workflowTemplatesTable.version));

  res.json(GetGenerationCapabilitiesResponse.parse(workflows.map((workflow) => {
    const mappingNames = Object.keys(workflow.mappings ?? {});
    return {
      id: workflow.id,
      name: workflow.name,
      generationMode: workflow.generationMode,
      modelFamily: workflow.modelFamily,
      supportsReferenceVideo: mappingNames.includes("referenceVideo"),
      supportsCharacterReferences: mappingNames.some((field) => /^referenceImage\d+$/.test(field)),
      supportsSettingReference: mappingNames.some((field) => /^settingImage\d+$/.test(field)),
      ...getWorkflowReferenceRequirements(workflow.apiWorkflow, workflow.mappings),
    };
  })));
});

export default router;