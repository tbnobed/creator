CREATE TABLE "obtv_character_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"angle" text,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt_description" text DEFAULT '' NOT NULL,
	"thumbnail" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"voice_profile" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_comfy_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"hostname" text NOT NULL,
	"api_base_url" text NOT NULL,
	"websocket_url" text NOT NULL,
	"gpu_name" text,
	"vram_gb" real,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_concurrent_jobs" integer,
	"status" text DEFAULT 'UNKNOWN' NOT NULL,
	"queue_size" integer DEFAULT 0 NOT NULL,
	"active_job_count" integer DEFAULT 0 NOT NULL,
	"memory_used_gb" real,
	"last_heartbeat" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_generation_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_job_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"workflow_template_id" uuid,
	"comfy_server_id" uuid,
	"comfy_prompt_id" text,
	"prompt" text NOT NULL,
	"compiled_prompt" text NOT NULL,
	"negative_prompt" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"fps" integer NOT NULL,
	"frame_count" integer NOT NULL,
	"duration_seconds" real NOT NULL,
	"seed" integer,
	"generation_mode" text NOT NULL,
	"quality_preset" text NOT NULL,
	"progress" real,
	"current_node" text,
	"error_message" text,
	"output_storage_key" text,
	"output_mime_type" text,
	"parent_generation_id" uuid,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_generation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_job_id" uuid NOT NULL,
	"setting_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_setting_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setting_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt_description" text DEFAULT '' NOT NULL,
	"thumbnail" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"generation_mode" text NOT NULL,
	"model_family" text NOT NULL,
	"api_workflow" jsonb,
	"compatible_server_tags" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_inputs" text[] DEFAULT '{}' NOT NULL,
	"expected_outputs" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_character_assets" ADD CONSTRAINT "obtv_character_assets_character_id_obtv_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."obtv_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_characters" ADD CONSTRAINT "obtv_generation_characters_generation_job_id_obtv_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."obtv_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_characters" ADD CONSTRAINT "obtv_generation_characters_character_id_obtv_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."obtv_characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD CONSTRAINT "obtv_generation_jobs_workflow_template_id_obtv_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."obtv_workflow_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD CONSTRAINT "obtv_generation_jobs_comfy_server_id_obtv_comfy_servers_id_fk" FOREIGN KEY ("comfy_server_id") REFERENCES "public"."obtv_comfy_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_settings" ADD CONSTRAINT "obtv_generation_settings_generation_job_id_obtv_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."obtv_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_settings" ADD CONSTRAINT "obtv_generation_settings_setting_id_obtv_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."obtv_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_setting_assets" ADD CONSTRAINT "obtv_setting_assets_setting_id_obtv_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."obtv_settings"("id") ON DELETE cascade ON UPDATE no action;