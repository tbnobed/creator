import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { comfyServersTable, tenantsTable, usersTable } from "./obtv";

export type ImageStudioProvider = "LOCAL" | "CLOUD";
export type ImageStudioJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const imageStudioJobsTable = pgTable(
  "obtv_image_studio_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
    createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
    requestKey: uuid("request_key"),
    modelId: text("model_id").notNull(),
    modelName: text("model_name").notNull(),
    provider: text("provider").notNull().$type<ImageStudioProvider>(),
    operation: text("operation").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    count: integer("count").notNull(),
    seed: integer("seed"),
    referenceAssetIds: text("reference_asset_ids").array().notNull().default([]),
    maskAssetId: uuid("mask_asset_id"),
    status: text("status").notNull().default("QUEUED").$type<ImageStudioJobStatus>(),
    errorMessage: text("error_message"),
    providerRequestId: text("provider_request_id"),
    providerTaskMetadata: jsonb("provider_task_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    comfyServerId: uuid("comfy_server_id").references(() => comfyServersTable.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("obtv_image_studio_jobs_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("obtv_image_studio_jobs_status_idx").on(table.status),
    uniqueIndex("obtv_image_studio_jobs_tenant_request_key_unique").on(
      table.tenantId,
      table.requestKey,
    ),
  ],
);

export type ImageStudioJob = typeof imageStudioJobsTable.$inferSelect;