CREATE TABLE "obtv_tenant_memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obtv_tenant_memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "obtv_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obtv_tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "obtv_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text DEFAULT 'OBTV User' NOT NULL,
	"site_role" text DEFAULT 'USER' NOT NULL,
	"active_tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "obtv_settings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "obtv_settings" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
INSERT INTO "obtv_users" ("id", "display_name", "site_role")
VALUES ('__obtv_legacy__', 'Legacy OBTV content', 'USER')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "obtv_tenants" ("name", "slug", "is_default", "created_by_user_id")
VALUES ('OBTV', 'obtv-default', true, '__obtv_legacy__')
ON CONFLICT ("slug") DO UPDATE SET "is_default" = true;--> statement-breakpoint
UPDATE "obtv_characters" SET
  "tenant_id" = (SELECT "id" FROM "obtv_tenants" WHERE "slug" = 'obtv-default'),
  "created_by_user_id" = '__obtv_legacy__'
WHERE "tenant_id" IS NULL OR "created_by_user_id" IS NULL;--> statement-breakpoint
UPDATE "obtv_settings" SET
  "tenant_id" = (SELECT "id" FROM "obtv_tenants" WHERE "slug" = 'obtv-default'),
  "created_by_user_id" = '__obtv_legacy__'
WHERE "tenant_id" IS NULL OR "created_by_user_id" IS NULL;--> statement-breakpoint
UPDATE "obtv_generation_jobs" SET
  "tenant_id" = (SELECT "id" FROM "obtv_tenants" WHERE "slug" = 'obtv-default'),
  "created_by_user_id" = '__obtv_legacy__'
WHERE "tenant_id" IS NULL OR "created_by_user_id" IS NULL;--> statement-breakpoint
UPDATE "obtv_long_form_projects" SET
  "tenant_id" = (SELECT "id" FROM "obtv_tenants" WHERE "slug" = 'obtv-default'),
  "created_by_user_id" = '__obtv_legacy__'
WHERE "tenant_id" IS NULL OR "created_by_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_characters" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_settings" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_settings" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "obtv_tenant_memberships" ADD CONSTRAINT "obtv_tenant_memberships_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_tenant_memberships" ADD CONSTRAINT "obtv_tenant_memberships_user_id_obtv_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."obtv_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_tenants" ADD CONSTRAINT "obtv_tenants_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_users_email_unique" ON "obtv_users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD CONSTRAINT "obtv_characters_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_characters" ADD CONSTRAINT "obtv_characters_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD CONSTRAINT "obtv_generation_jobs_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_generation_jobs" ADD CONSTRAINT "obtv_generation_jobs_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ADD CONSTRAINT "obtv_long_form_projects_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_long_form_projects" ADD CONSTRAINT "obtv_long_form_projects_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_settings" ADD CONSTRAINT "obtv_settings_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_settings" ADD CONSTRAINT "obtv_settings_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "obtv_users" ADD CONSTRAINT "obtv_users_site_role_check" CHECK ("site_role" IN ('SITE_ADMIN', 'USER'));--> statement-breakpoint
ALTER TABLE "obtv_tenant_memberships" ADD CONSTRAINT "obtv_tenant_memberships_role_check" CHECK ("role" IN ('OWNER', 'ADMIN', 'MEMBER'));