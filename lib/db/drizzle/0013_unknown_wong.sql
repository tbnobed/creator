DROP INDEX "obtv_spending_events_entry_state_unique";--> statement-breakpoint
ALTER TABLE "obtv_spending_entries" ADD COLUMN "billed_micros" bigint;--> statement-breakpoint
ALTER TABLE "obtv_spending_entries" ADD COLUMN "billing_reference" text;--> statement-breakpoint
ALTER TABLE "obtv_spending_entries" ADD COLUMN "billing_request_id" text;--> statement-breakpoint
ALTER TABLE "obtv_spending_entries" ADD COLUMN "provider_endpoint" text;--> statement-breakpoint
ALTER TABLE "obtv_spending_events" ADD COLUMN "billed_micros" bigint;--> statement-breakpoint
ALTER TABLE "obtv_spending_events" ADD COLUMN "billing_reference" text;