import { pgTable, text, timestamp, index, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./obtv";

export const passwordResetsTable = pgTable("obtv_password_resets", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("obtv_password_resets_user_idx").on(t.userId)]);

export const authRateLimitsTable = pgTable("obtv_auth_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
