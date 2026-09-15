ALTER TABLE "obtv_image_studio_jobs" ADD COLUMN "character_id" uuid;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD COLUMN "reference_label" text;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD COLUMN "output_storage_key" text;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD COLUMN "output_mime_type" text;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD CONSTRAINT "obtv_image_studio_jobs_character_id_obtv_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."obtv_characters"("id") ON DELETE cascade ON UPDATE no action;