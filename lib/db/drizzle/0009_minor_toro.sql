ALTER TABLE "obtv_tenant_invitations" ADD COLUMN "target_user_id" text;--> statement-breakpoint
ALTER TABLE "obtv_tenant_invitations" ADD COLUMN "allows_password_enrollment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DELETE FROM "obtv_tenant_invitations";--> statement-breakpoint
ALTER TABLE "obtv_tenant_invitations" ADD CONSTRAINT "obtv_tenant_invitations_target_user_id_obtv_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE cascade ON UPDATE no action;