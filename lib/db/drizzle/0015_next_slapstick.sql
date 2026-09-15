ALTER TABLE "obtv_character_assets" ADD COLUMN "label" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
UPDATE "obtv_character_assets"
SET "label" = "angle"
WHERE "label" = 'other'
  AND "angle" IN ('headshot', 'profile', 'three-quarter', 'full-body', 'expression', 'wardrobe', 'other');--> statement-breakpoint
ALTER TABLE "obtv_character_assets" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "dossier" jsonb DEFAULT '{"role":"","performanceNotes":"","wardrobes":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "dossier_status" text DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "dossier_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "dossier_approved_at" timestamp with time zone;--> statement-breakpoint