CREATE TABLE "obtv_long_form_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"script" text NOT NULL,
	"storyline" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"target_duration_seconds" integer NOT NULL,
	"generation_mode" text NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"fps" integer NOT NULL,
	"quality_preset" text NOT NULL,
	"character_ids" text[] DEFAULT '{}' NOT NULL,
	"setting_id" uuid,
	"total_shots" integer DEFAULT 0 NOT NULL,
	"completed_shots" integer DEFAULT 0 NOT NULL,
	"failed_shots" integer DEFAULT 0 NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"final_output_storage_key" text,
	"final_output_mime_type" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_long_form_shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scene_number" integer NOT NULL,
	"shot_number" integer NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"dialogue" text DEFAULT '' NOT NULL,
	"camera_instructions" text DEFAULT '' NOT NULL,
	"motion_instructions" text DEFAULT '' NOT NULL,
	"continuity_note" text DEFAULT '' NOT NULL,
	"transition" text DEFAULT 'CUT' NOT NULL,
	"duration_seconds" real NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"character_ids" text[] DEFAULT '{}' NOT NULL,
	"setting_id" uuid,
	"generation_job_id" uuid,
	"assigned_server_id" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"output_storage_key" text,
	"output_mime_type" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ADD CONSTRAINT "obtv_long_form_projects_setting_id_obtv_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."obtv_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_shots" ADD CONSTRAINT "obtv_long_form_shots_project_id_obtv_long_form_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."obtv_long_form_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_shots" ADD CONSTRAINT "obtv_long_form_shots_setting_id_obtv_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."obtv_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_shots" ADD CONSTRAINT "obtv_long_form_shots_generation_job_id_obtv_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."obtv_generation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_shots" ADD CONSTRAINT "obtv_long_form_shots_assigned_server_id_obtv_comfy_servers_id_fk" FOREIGN KEY ("assigned_server_id") REFERENCES "public"."obtv_comfy_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_long_form_shots_project_scene_shot_unique" ON "obtv_long_form_shots" USING btree ("project_id","scene_number","shot_number");