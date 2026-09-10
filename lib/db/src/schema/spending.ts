import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const spendingEntriesTable = pgTable(
  "obtv_spending_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    tenantName: text("tenant_name").notNull(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email"),
    userDisplayName: text("user_display_name").notNull(),
    memberRole: text("member_role").notNull().$type<"OWNER" | "ADMIN" | "MEMBER">(),
    sourceType: text("source_type").notNull().$type<"image" | "video">(),
    sourceId: text("source_id").notNull(),
    modelId: text("model_id").notNull(),
    estimatedMicros: bigint("estimated_micros", { mode: "number" }).notNull(),
    billedMicros: bigint("billed_micros", { mode: "number" }),
    billingReference: text("billing_reference"),
    billingRequestId: text("billing_request_id"),
    providerEndpoint: text("provider_endpoint"),
    pricingNote: text("pricing_note").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    outcome: text("outcome")
      .notNull()
      .default("reserved")
      .$type<"reserved" | "estimated" | "released" | "uncertain" | "actual">(),
    settlementNote: text("settlement_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("obtv_spending_entries_source_unique").on(table.sourceType, table.sourceId),
    index("obtv_spending_entries_tenant_period_idx").on(table.tenantId, table.periodStart),
    index("obtv_spending_entries_user_period_idx").on(table.userId, table.periodStart),
  ],
);

export const spendingEventsTable = pgTable(
  "obtv_spending_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spendingEntryId: uuid("spending_entry_id")
      .notNull()
      .references(() => spendingEntriesTable.id),
    state: text("state")
      .notNull()
      .$type<"reserved" | "estimated" | "released" | "uncertain" | "actual" | "receipt_attached">(),
    billedMicros: bigint("billed_micros", { mode: "number" }),
    billingReference: text("billing_reference"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("obtv_spending_events_entry_created_idx").on(table.spendingEntryId, table.createdAt),
  ],
);

export type SpendingEntry = typeof spendingEntriesTable.$inferSelect;
export type SpendingEvent = typeof spendingEventsTable.$inferSelect;