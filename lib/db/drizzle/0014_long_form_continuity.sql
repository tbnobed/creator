ALTER TABLE "obtv_long_form_projects"
  ADD COLUMN "continuity" jsonb DEFAULT '{"enabled":false,"characters":[],"scenes":[]}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "obtv_long_form_shots"
  ADD COLUMN "continuity" jsonb DEFAULT '{"voiceCloningEnabled":false}'::jsonb NOT NULL,
  ADD COLUMN "still_storage_key" text,
  ADD COLUMN "still_mime_type" text,
  ADD COLUMN "still_asset_id" uuid,
  ADD COLUMN "still_status" text DEFAULT 'NONE' NOT NULL,
  ADD COLUMN "still_revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "still_approved_at" timestamp with time zone,
  ADD COLUMN "still_review_note" text;
--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs"
  ADD COLUMN "voice_character_id" uuid,
  ADD COLUMN "reference_image_keys" text[] DEFAULT '{}' NOT NULL;