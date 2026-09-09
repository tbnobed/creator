CREATE TABLE "obtv_tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_tenant_invitations" ADD CONSTRAINT "obtv_tenant_invitations_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_tenant_invitations" ADD CONSTRAINT "obtv_tenant_invitations_invited_by_user_id_obtv_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_tenant_invitations_token_hash_unique" ON "obtv_tenant_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "obtv_tenant_invitations_expires_at_idx" ON "obtv_tenant_invitations" USING btree ("expires_at");