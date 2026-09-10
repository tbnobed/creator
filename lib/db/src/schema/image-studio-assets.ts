import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { imageStudioJobsTable } from "./image-studio-jobs";
import { tenantsTable, usersTable } from "./obtv";

export const imageStudioAssetsTable = pgTable(
  "obtv_image_studio_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
    createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
    jobId: uuid("job_id").references(() => imageStudioJobsTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    favorite: boolean("favorite").notNull().default(false),
    collection: text("collection").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("obtv_image_studio_assets_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("obtv_image_studio_assets_job_idx").on(table.jobId),
  ],
);

export type ImageStudioAsset = typeof imageStudioAssetsTable.$inferSelect;