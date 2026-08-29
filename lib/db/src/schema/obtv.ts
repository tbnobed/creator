import {
  boolean,
  integer,
  jsonb,
  pgTable,
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

export const charactersTable = pgTable("obtv_characters", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  promptDescription: text("prompt_description").notNull().default(""),
  thumbnail: text("thumbnail"),
  tags: text("tags").array().notNull().default([]),
  voiceProfile: text("voice_profile"),
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
  userId: text("user_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("DRAFT"),
  workflowTemplateId: uuid("workflow_template_id").references(
    () => workflowTemplatesTable.id,
  ),
  longFormShotId: uuid("long_form_shot_id"),
  comfyServerId: uuid("comfy_server_id").references(() => comfyServersTable.id),
  comfyPromptId: text("comfy_prompt_id"),
  prompt: text("prompt").notNull(),
  compiledPrompt: text("compiled_prompt").notNull(),
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
export type Setting = typeof settingsTable.$inferSelect;
export type ComfyServer = typeof comfyServersTable.$inferSelect;
export type WorkflowTemplate = typeof workflowTemplatesTable.$inferSelect;
export type GenerationJob = typeof generationJobsTable.$inferSelect;
export type LongFormProject = typeof longFormProjectsTable.$inferSelect;
export type LongFormShot = typeof longFormShotsTable.$inferSelect;