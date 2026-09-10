CREATE TABLE "obtv_image_studio_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"model_name" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"count" integer NOT NULL,
	"seed" integer,
	"reference_asset_ids" text[] DEFAULT '{}' NOT NULL,
	"mask_asset_id" uuid,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"error_message" text,
	"provider_request_id" text,
	"provider_task_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"comfy_server_id" uuid,
	"submitted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_image_studio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"job_id" uuid,
	"name" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"collection" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD CONSTRAINT "obtv_image_studio_jobs_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD CONSTRAINT "obtv_image_studio_jobs_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_jobs" ADD CONSTRAINT "obtv_image_studio_jobs_comfy_server_id_obtv_comfy_servers_id_fk" FOREIGN KEY ("comfy_server_id") REFERENCES "public"."obtv_comfy_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_assets" ADD CONSTRAINT "obtv_image_studio_assets_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_assets" ADD CONSTRAINT "obtv_image_studio_assets_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_image_studio_assets" ADD CONSTRAINT "obtv_image_studio_assets_job_id_obtv_image_studio_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."obtv_image_studio_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "obtv_image_studio_jobs_tenant_created_idx" ON "obtv_image_studio_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "obtv_image_studio_jobs_status_idx" ON "obtv_image_studio_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "obtv_image_studio_assets_tenant_created_idx" ON "obtv_image_studio_assets" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "obtv_image_studio_assets_job_idx" ON "obtv_image_studio_assets" USING btree ("job_id");