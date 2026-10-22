import { pgTable, uuid, text, integer, jsonb, timestamp, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenantsTable, usersTable, charactersTable } from "./obtv";

export type CharacterLookSlot = {
  index: number;
  /** Reference-sheet view (front, three-quarter, profile, expressions); absent for portraits. */
  view?: string;
  /** Durable idempotency key for the image-studio job. Replaced only when a failed slot is explicitly retried. */
  requestKey: string;
  jobId?: string;
  status: "PENDING" | "RUNNING" | "READY" | "FAILED";
  assetId?: string;
  mediaUrl?: string;
  /** Character asset created by the server for reference-sheet slots. */
  characterAssetId?: string;
  error?: string;
  attempts?: number;
  /** Backoff for ambiguous submissions; the request key is kept so the retry reconciles. */
  nextAttemptAt?: string;
};

/**
 * One four-image batch owned by a character: either portrait options or the
 * reference sheet created from a kept portrait. Submission, completion and
 * attachment are advanced by the API server, never by the browser.
 */
export const characterLookBatchesTable = pgTable("obtv_character_look_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  characterId: uuid("character_id").notNull().references(() => charactersTable.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  kind: text("kind").notNull().$type<"PORTRAITS" | "SHEET">(),
  requestKey: text("request_key").notNull(),
  modelId: text("model_id").notNull(),
  cloudConfirmed: boolean("cloud_confirmed").notNull().default(false),
  prompt: text("prompt").notNull(),
  seed: integer("seed").notNull(),
  sourceBatchId: uuid("source_batch_id"),
  sourceAssetId: uuid("source_asset_id"),
  selectedAssetId: uuid("selected_asset_id"),
  status: text("status").notNull().default("ACTIVE").$type<"ACTIVE" | "COMPLETED" | "FAILED">(),
  slots: jsonb("slots").$type<CharacterLookSlot[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("obtv_character_look_batches_request_key").on(t.tenantId, t.requestKey),
  index("obtv_character_look_batches_character").on(t.characterId, t.createdAt),
  index("obtv_character_look_batches_status").on(t.status),
]);
export type CharacterLookBatch = typeof characterLookBatchesTable.$inferSelect;
