import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { generationJobsTable, tenantsTable } from "./obtv";

export const videoLibraryStatesTable = pgTable("obtv_video_library_states", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  generationJobId: uuid("generation_job_id").notNull().references(() => generationJobsTable.id, { onDelete: "cascade" }),
  favorite: boolean("favorite").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  undoToken: uuid("undo_token"),
  undoExpiresAt: timestamp("undo_expires_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("obtv_video_library_states_job_unique").on(table.generationJobId),
  index("obtv_video_library_states_tenant_deleted_idx").on(table.tenantId, table.deletedAt),
  index("obtv_video_library_states_tenant_undo_idx").on(table.tenantId, table.undoToken),
]);