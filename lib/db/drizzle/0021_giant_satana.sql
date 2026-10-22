CREATE TABLE "obtv_character_look_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_key" text NOT NULL,
	"model_id" text NOT NULL,
	"cloud_confirmed" boolean DEFAULT false NOT NULL,
	"prompt" text NOT NULL,
	"seed" integer NOT NULL,
	"source_batch_id" uuid,
	"source_asset_id" uuid,
	"selected_asset_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "obtv_character_look_batches" ADD CONSTRAINT "obtv_character_look_batches_tenant_id_obtv_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."obtv_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_character_look_batches" ADD CONSTRAINT "obtv_character_look_batches_character_id_obtv_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."obtv_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obtv_character_look_batches" ADD CONSTRAINT "obtv_character_look_batches_created_by_user_id_obtv_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."obtv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obtv_character_look_batches_request_key" ON "obtv_character_look_batches" USING btree ("tenant_id","request_key");--> statement-breakpoint
CREATE INDEX "obtv_character_look_batches_character" ON "obtv_character_look_batches" USING btree ("character_id","created_at");--> statement-breakpoint
CREATE INDEX "obtv_character_look_batches_status" ON "obtv_character_look_batches" USING btree ("status");