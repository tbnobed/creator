import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const usersTable = pgTable(
  "obtv_users",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull().default("OBTV User"),
    siteRole: text("site_role").notNull().default("USER").$type<"SITE_ADMIN" | "USER">(),
    activeTenantId: uuid("active_tenant_id"),
    ...timestamps,
  },
  (table) => [uniqueIndex("obtv_users_email_unique").on(table.email)],
);

export const authSessionsTable = pgTable(
  "obtv_auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("obtv_auth_sessions_expires_at_idx").on(table.expiresAt)],
);

export const tenantsTable = pgTable("obtv_tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  isDefault: boolean("is_default").notNull().default(false),
  createdByUserId: text("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  ...timestamps,
});

export const tenantMembershipsTable = pgTable(
  "obtv_tenant_memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("MEMBER").$type<"OWNER" | "ADMIN" | "MEMBER">(),
    monthlyLimitMicros: bigint("monthly_limit_micros", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

export const tenantInvitationsTable = pgTable(
  "obtv_tenant_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("MEMBER").$type<"OWNER" | "ADMIN" | "MEMBER">(),
    monthlyLimitMicros: bigint("monthly_limit_micros", { mode: "number" }),
    tokenHash: text("token_hash").notNull(),
    targetUserId: text("target_user_id")
      .references(() => usersTable.id, { onDelete: "cascade" }),
    allowsPasswordEnrollment: boolean("allows_password_enrollment").notNull().default(false),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("obtv_tenant_invitations_token_hash_unique").on(table.tokenHash),
    index("obtv_tenant_invitations_expires_at_idx").on(table.expiresAt),
  ],
);

export const charactersTable = pgTable("obtv_characters", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  promptDescription: text("prompt_description").notNull().default(""),
  thumbnail: text("thumbnail"),
  tags: text("tags").array().notNull().default([]),
  voiceProfile: text("voice_profile"),
  voiceStorageKey: text("voice_storage_key"),
  voiceOriginalName: text("voice_original_name"),
  voiceMimeType: text("voice_mime_type"),
  voiceConsentAt: timestamp("voice_consent_at", { withTimezone: true }),
  ...timestamps,
});

export const characterAssetsTable = pgTable("obtv_character_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  characterId: uuid("character_id")
    .notNull()
    .references(() => charactersTable.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  angle: text("angle"),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const settingsTable = pgTable("obtv_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  promptDescription: text("prompt_description").notNull().default(""),
  thumbnail: text("thumbnail"),
  tags: text("tags").array().notNull().default([]),
  ...timestamps,
});

export const settingAssetsTable = pgTable("obtv_setting_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  settingId: uuid("setting_id")
    .notNull()
    .references(() => settingsTable.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  description: text("description").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const comfyServersTable = pgTable("obtv_comfy_servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: text("display_name").notNull(),
  hostname: text("hostname").notNull(),
  apiBaseUrl: text("api_base_url").notNull(),
  websocketUrl: text("websocket_url").notNull(),
  gpuName: text("gpu_name"),
  vramGb: real("vram_gb"),
  tags: text("tags").array().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(0),
  maxConcurrentJobs: integer("max_concurrent_jobs"),
  status: text("status").notNull().default("UNKNOWN"),
  queueSize: integer("queue_size").notNull().default(0),
  activeJobCount: integer("active_job_count").notNull().default(0),
  memoryUsedGb: real("memory_used_gb"),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  ...timestamps,
});

export const workflowTemplatesTable = pgTable("obtv_workflow_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  generationMode: text("generation_mode").notNull(),
  modelFamily: text("model_family").notNull(),
  apiWorkflow: jsonb("api_workflow").$type<Record<string, unknown>>(),
  compatibleServerTags: text("compatible_server_tags").array().notNull().default([]),
  active: boolean("active").notNull().default(false),
  version: integer("version").notNull().default(1),
  mappings: jsonb("mappings").$type<Record<string, { nodeId: string; input: string }>>().notNull().default({}),
  expectedInputs: text("expected_inputs").array().notNull().default([]),
  expectedOutputs: text("expected_outputs").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const generationJobsTable = pgTable("obtv_generation_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  userId: text("user_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("DRAFT"),
  workflowTemplateId: uuid("workflow_template_id").references(
    () => workflowTemplatesTable.id,
  ),
  longFormShotId: uuid("long_form_shot_id"),
  comfyServerId: uuid("comfy_server_id").references(() => comfyServersTable.id),
  comfyPromptId: text("comfy_prompt_id"),
  provider: text("provider").notNull().default("COMFYUI"),
  providerModelId: text("provider_model_id"),
  providerRequestId: text("provider_request_id"),
  providerTaskMetadata: jsonb("provider_task_metadata").$type<Record<string, unknown>>().notNull().default({}),
  voiceCloningEnabled: boolean("voice_cloning_enabled").notNull().default(false),
  voiceCharacterId: uuid("voice_character_id"),
  referenceImageKeys: text("reference_image_keys").array().notNull().default([]),
  prompt: text("prompt").notNull(),
  compiledPrompt: text("compiled_prompt").notNull(),
  dialogue: text("dialogue").notNull().default(""),
  negativePrompt: text("negative_prompt"),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  fps: integer("fps").notNull(),
  frameCount: integer("frame_count").notNull(),
  durationSeconds: real("duration_seconds").notNull(),
  seed: integer("seed"),
  generationMode: text("generation_mode").notNull(),
  qualityPreset: text("quality_preset").notNull(),
  progress: real("progress"),
  currentNode: text("current_node"),
  errorMessage: text("error_message"),
  outputStorageKey: text("output_storage_key"),
  outputMimeType: text("output_mime_type"),
  parentGenerationId: uuid("parent_generation_id"),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const longFormProjectsTable = pgTable("obtv_long_form_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: text("created_by_user_id").notNull().references(() => usersTable.id),
  title: text("title").notNull(),
  script: text("script").notNull(),
  storyline: text("storyline").notNull().default(""),
  status: text("status").notNull().default("DRAFT"),
  targetDurationSeconds: integer("target_duration_seconds").notNull(),
  generationMode: text("generation_mode").notNull(),
  negativePrompt: text("negative_prompt").notNull().default(""),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  fps: integer("fps").notNull(),
  qualityPreset: text("quality_preset").notNull(),
  characterIds: text("character_ids").array().notNull().default([]),
  settingId: uuid("setting_id").references(() => settingsTable.id),
  totalShots: integer("total_shots").notNull().default(0),
  completedShots: integer("completed_shots").notNull().default(0),
  failedShots: integer("failed_shots").notNull().default(0),
  progress: real("progress").notNull().default(0),
  timelineClips: jsonb("timeline_clips")
    .$type<LongFormTimelineClip[]>()
    .notNull()
    .default([]),
  continuity: jsonb("continuity")
    .$type<LongFormContinuitySettings>()
    .notNull()
    .default({ enabled: false, characters: [], scenes: [] }),
  finalOutputStorageKey: text("final_output_storage_key"),
  finalOutputMimeType: text("final_output_mime_type"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  ...timestamps,
});

export type LongFormTimelineClip = {
  shotId: string;
  trimStartSeconds: number;
  trimEndSeconds: number;
};

export type LongFormContinuityWardrobe = {
  id: string;
  name: string;
  description: string;
  referenceAssetId?: string;
};

export type LongFormContinuityCharacter = {
  characterId: string;
  appearance: string;
  behavior: string;
  voiceDescription: string;
  wardrobes: LongFormContinuityWardrobe[];
};

export type LongFormContinuityScene = {
  sceneNumber: number;
  title: string;
  settingNotes: string;
  emotionNotes: string;
  wardrobeAssignments: Array<{ characterId: string; wardrobeId: string }>;
};

export type LongFormContinuitySettings = {
  enabled: boolean;
  characters: LongFormContinuityCharacter[];
  scenes: LongFormContinuityScene[];
};

export type LongFormShotContinuity = {
  characterIds?: string[];
  speakerCharacterId?: string;
  voiceCloningEnabled: boolean;
  emotionNotes?: string;
  performanceNotes?: string;
};

export const longFormShotsTable = pgTable(
  "obtv_long_form_shots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => longFormProjectsTable.id, { onDelete: "cascade" }),
    sceneNumber: integer("scene_number").notNull(),
    shotNumber: integer("shot_number").notNull(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    dialogue: text("dialogue").notNull().default(""),
    cameraInstructions: text("camera_instructions").notNull().default(""),
    motionInstructions: text("motion_instructions").notNull().default(""),
    continuityNote: text("continuity_note").notNull().default(""),
    transition: text("transition").notNull().default("CUT"),
    durationSeconds: real("duration_seconds").notNull(),
    status: text("status").notNull().default("PLANNED"),
    characterIds: text("character_ids").array().notNull().default([]),
    continuity: jsonb("continuity")
      .$type<LongFormShotContinuity>()
      .notNull()
      .default({ voiceCloningEnabled: false }),
    stillStorageKey: text("still_storage_key"),
    stillMimeType: text("still_mime_type"),
    stillAssetId: uuid("still_asset_id"),
    stillStatus: text("still_status").notNull().default("NONE"),
    stillRevision: integer("still_revision").notNull().default(0),
    stillApprovedAt: timestamp("still_approved_at", { withTimezone: true }),
    stillReviewNote: text("still_review_note"),
    settingId: uuid("setting_id").references(() => settingsTable.id),
    generationJobId: uuid("generation_job_id").references(() => generationJobsTable.id),
    assignedServerId: uuid("assigned_server_id").references(() => comfyServersTable.id),
    retryCount: integer("retry_count").notNull().default(0),
    outputStorageKey: text("output_storage_key"),
    outputMimeType: text("output_mime_type"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("obtv_long_form_shots_project_scene_shot_unique").on(
      table.projectId,
      table.sceneNumber,
      table.shotNumber,
    ),
  ],
);

export const generationCharactersTable = pgTable("obtv_generation_characters", {
  id: uuid("id").defaultRandom().primaryKey(),
  generationJobId: uuid("generation_job_id")
    .notNull()
    .references(() => generationJobsTable.id, { onDelete: "cascade" }),
  characterId: uuid("character_id")
    .notNull()
    .references(() => charactersTable.id),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const generationSettingsTable = pgTable("obtv_generation_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  generationJobId: uuid("generation_job_id")
    .notNull()
    .references(() => generationJobsTable.id, { onDelete: "cascade" }),
  settingId: uuid("setting_id")
    .notNull()
    .references(() => settingsTable.id),
});

export type Character = typeof charactersTable.$inferSelect;
export type ObtvUser = typeof usersTable.$inferSelect;
export type Tenant = typeof tenantsTable.$inferSelect;
export type TenantMembership = typeof tenantMembershipsTable.$inferSelect;
export type Setting = typeof settingsTable.$inferSelect;
export type ComfyServer = typeof comfyServersTable.$inferSelect;
export type WorkflowTemplate = typeof workflowTemplatesTable.$inferSelect;
export type GenerationJob = typeof generationJobsTable.$inferSelect;
export type LongFormProject = typeof longFormProjectsTable.$inferSelect;
export type LongFormShot = typeof longFormShotsTable.$inferSelect;