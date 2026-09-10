CREATE TABLE "obtv_spending_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_name" text NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text,
	"user_display_name" text NOT NULL,
	"member_role" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"model_id" text NOT NULL,
	"estimated_micros" bigint NOT NULL,
	"pricing_note" text NOT NULL,
	"period_start" date NOT NULL,
	"outcome" text DEFAULT 'reserved' NOT NULL,
	"settlement_note" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "obtv_spending_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spending_entry_id" uuid NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_tenant_invitations" ADD COLUMN "monthly_limit_micros" bigint;--> statement-breakpoint
ALTER TABLE "obtv_tenant_memberships" ADD COLUMN "monthly_limit_micros" bigint;--> statement-breakpoint
ALTER TABLE "obtv_spending_events" ADD CONSTRAINT "obtv_spending_events_spending_entry_id_obtv_spending_entries_id_fk" FOREIGN KEY ("spending_entry_id") REFERENCES "public"."obtv_spending_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_spending_entries_source_unique" ON "obtv_spending_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "obtv_spending_entries_tenant_period_idx" ON "obtv_spending_entries" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE INDEX "obtv_spending_entries_user_period_idx" ON "obtv_spending_entries" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_spending_events_entry_state_unique" ON "obtv_spending_events" USING btree ("spending_entry_id","state");--> statement-breakpoint
CREATE INDEX "obtv_spending_events_entry_created_idx" ON "obtv_spending_events" USING btree ("spending_entry_id","created_at");