import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable, usersTable, longFormProjectsTable } from "./obtv";

// A production draft exists before a render plan. Keep existing render projects
// intact; renderProjectId connects the approved draft to the existing queue.
export const productionProjectsTable = pgTable("obtv_production_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  title: text("title").notNull().default("Untitled project"),
  revision: integer("revision").notNull().default(0),
  state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
  renderProjectId: uuid("render_project_id").references(() => longFormProjectsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ProductionProjectRow = typeof productionProjectsTable.$inferSelect;
