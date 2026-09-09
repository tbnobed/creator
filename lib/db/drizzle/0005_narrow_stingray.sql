ALTER TABLE "obtv_generation_jobs" ADD COLUMN "provider" text DEFAULT 'COMFYUI' NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "provider_model_id" text;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "provider_task_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "voice_cloning_enabled" boolean DEFAULT false NOT NULL;