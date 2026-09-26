CREATE TABLE "obtv_video_library_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"generation_job_id" uuid NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"undo_token" uuid,
	"undo_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "obtv_video_library_states" ADD CONSTRAINT "obtv_video_library_states_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_video_library_states" ADD CONSTRAINT "obtv_video_library_states_generation_job_id_obtv_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."obtv_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_video_library_states_job_unique" ON "obtv_video_library_states" USING btree ("generation_job_id");--> statement-breakpoint
CREATE INDEX "obtv_video_library_states_tenant_deleted_idx" ON "obtv_video_library_states" USING btree ("tenant_id","deleted_at");--> statement-breakpoint
CREATE INDEX "obtv_video_library_states_tenant_undo_idx" ON "obtv_video_library_states" USING btree ("tenant_id","undo_token");