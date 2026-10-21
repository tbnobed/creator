CREATE TABLE "obtv_production_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"title" text DEFAULT 'Untitled project' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"render_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_production_projects" ADD CONSTRAINT "obtv_production_projects_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_production_projects" ADD CONSTRAINT "obtv_production_projects_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_production_projects" ADD CONSTRAINT "obtv_production_projects_render_project_id_obtv_long_form_projects_id_fk" FOREIGN KEY ("render_project_id") REFERENCES "public"."obtv_long_form_projects"("id") ON DELETE set null ON UPDATE no action;