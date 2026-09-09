ALTER TABLE "obtv_characters" ADD COLUMN "voice_storage_key" text;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "voice_original_name" text;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "voice_mime_type" text;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "voice_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "dialogue" text DEFAULT '' NOT NULL;