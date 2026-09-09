CREATE TABLE "obtv_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "obtv_auth_sessions" ADD CONSTRAINT "obtv_auth_sessions_user_id_obtv_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."obtv_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "obtv_auth_sessions_expires_at_idx" ON "obtv_auth_sessions" USING btree ("expires_at");