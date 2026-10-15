CREATE TABLE "obtv_auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obtv_password_resets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_password_resets" ADD CONSTRAINT "obtv_password_resets_user_id_obtv_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."obtv_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "obtv_password_resets_user_idx" ON "obtv_password_resets" USING btree ("user_id");