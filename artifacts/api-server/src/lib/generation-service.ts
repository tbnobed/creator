import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  comfyServersTable,
  db,
  generationCharactersTable,
  generationJobsTable,
  generationSettingsTable,
  settingAssetsTable,
  settingsTable,
  workflowTemplatesTable,
  pool,
  type GenerationJob,
} from "@workspace/db";
import { logger } from "./logger";
import { ComfyUIClient } from "./comfy/client";
import { hasRequiredTags, isLongFormWorkflow } from "./comfy/scheduler";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import { mediaStorage } from "./storage-service";

const activeGenerationStatuses = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const generationTimeoutMessage = "Timed out while waiting for ComfyUI";
const generationTimeoutMs = 6 * 60 * 60 * 1000;
const maxConsecutiveMonitorErrors = 3;
const workerUnreachableMessage = "ComfyUI worker stopped responding after 3 consecutive checks. Retry the shot when the worker is online.";

async function withServerSlotLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`comfy-server:${serverId}`],
    );
    if (!lock.rows[0]?.locked) {
      throw new Error("The selected GPU is being reserved by another render. Try again shortly.");
    }
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`comfy-server:${serverId}`]);
    }
  } finally {
    client.release();
  }
}

export type GenerationRequest = {
  characterIds?: string[];
  settingId?: string;
  prompt: string;
  negativePrompt?: string;
  cameraInstructions?: string;
  dialogue?: string;
  motionInstructions?: string;
  audioInstructions?: string;
  generationMode: string;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  qualityPreset: string;
  seedMode: string;
  seed?: number | null;
  referenceVideoKey?: string;
  preferredServerId?: string;
  longFormShotId?: string;
  onJobCreated?: (job: GenerationJob) => Promise<void>;
};

function compileGenericPrompt(
  characters: { name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  const sections = [
    characters.length
      ? `CHARACTERS\n${characters.map((character) => `${character.name}: ${character.promptDescription}`).join("\n\n")}`
      : "",
    setting?.promptDescription ? `SETTING\n${setting.promptDescription}` : "",
    input.dialogue ? `DIALOGUE\n${input.dialogue}` : "",
    `ACTION\n${input.prompt}`,
    input.cameraInstructions ? `CAMERA\n${input.cameraInstructions}` : "",
    input.motionInstructions ? `MOTION\n${input.motionInstructions}` : "",
    input.audioInstructions ? `AUDIO\n${input.audioInstructions}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function compactPromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapedWordPattern(value: string): RegExp {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function shotPromptOnly(prompt: string): string {
  return prompt.split(/\bPROJECT\s+VISUAL\s+DIRECTION\b/i)[0].trim();
}

function ensureSentenceEnding(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function extractPromptAudio(prompt: string): { soundscape: string | null; music: string | null } {
  const audioSentence = prompt
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => /\b(ambience|ambient|room tone|soundscape|equipment sounds?|music|score)\b/i.test(sentence));
  if (!audioSentence) return { soundscape: null, music: null };

  const musicIndex = audioSentence.search(/\b(?:music|score)\b/i);
  const beforeMusic = musicIndex >= 0 ? audioSentence.slice(0, musicIndex) : "";
  const separatorCandidates = [" and ", ", ", "; "]
    .map((separator) => ({ separator, index: beforeMusic.lastIndexOf(separator) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => right.index - left.index);
  const musicStart = separatorCandidates[0]
    ? separatorCandidates[0].index + separatorCandidates[0].separator.length
    : 0;
  const sentenceWithoutMusic = audioSentence
    .slice(0, musicIndex >= 0 ? musicStart : audioSentence.length)
    .replace(/^(?:add|include|use)\s+/i, "")
    .replace(/\s+(?:and|,|;)\s*$/i, "")
    .replace(/[,\s;]+$/i, "")
    .trim();
  const soundscape = sentenceWithoutMusic.match(
    /\b(?:[\w-]+\s+){0,4}(?:ambience|ambient|room tone|soundscape|equipment sounds?|static)[^.?!]*/i,
  )?.[0]?.replace(/^[,\s]+|[,\s]+$/g, "") ?? null;
  const music = musicIndex >= 0
    ? audioSentence.slice(musicStart).replace(/^(?:add|include|use|a|an|the)\s+/i, "").trim()
    : null;

  return {
    soundscape: soundscape ? compactPromptText(soundscape) : null,
    music: music ? compactPromptText(music) : null,
  };
}

function compileMiniMaxH3StandardPrompt(
  characters: { name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  const settingSubjectNumber = setting ? characters.length + 1 : null;
  const dialogue = input.dialogue?.trim();
  const shotPrompt = shotPromptOnly(input.prompt);
  const referencedCharacters = characters.filter((character) => (
    escapedWordPattern(character.name).test(shotPrompt) ||
    /\b(?:presenter|character|woman|man|actor|person|subject|host|guest)\b/i.test(shotPrompt)
  ));
  const usesSettingReference = Boolean(
    setting && (
      escapedWordPattern(setting.name).test(shotPrompt) ||
      /\b(?:TBN|studio|control room|broadcast facility|broadcast studio|production room)\b/i.test(shotPrompt)
    ),
  );
  const subjectDefinitions = referencedCharacters.map((character) => (
    `<Subject ${characters.indexOf(character) + 1}> is ${character.name}, whose appearance and identity are defined by the supplied reference images: ${compactPromptText(character.promptDescription)}`
  ));
  if (setting && settingSubjectNumber && usesSettingReference) {
    subjectDefinitions.push(
      `<Subject ${settingSubjectNumber}> is the referenced environment: ${compactPromptText(setting.promptDescription)}`,
    );
  }
  const primarySpeaker = referencedCharacters[0]
    ? `<Subject ${characters.indexOf(referencedCharacters[0]) + 1}>`
    : "The on-screen speaker";
  const hasOnScreenSpeech = /\b(speaks?|talks?|says?|addresses?|looks directly into (?:the )?camera)\b/i.test(shotPrompt);
  const isVoiceover = !hasOnScreenSpeech && /\b(off[- ]screen|voice[- ]?over|narration)\b/i.test(shotPrompt);
  const hasAuthoredCamera = /\bcamera\s*:/i.test(shotPrompt);
  const hasAuthoredMotion = /\bmotion\s*:/i.test(shotPrompt);
  const spokenAction = dialogue
    ? isVoiceover
      ? `${primarySpeaker} (S1) says in an off-screen voiceover: <d>[English] ${dialogue}</d> while the corresponding on-screen character's lips remain completely closed.`
      : `${primarySpeaker} (S1) says clearly at a natural speaking rate: <d>[English] ${dialogue}</d>`
    : "";
  const characterPlacement = referencedCharacters
    .map((character) => `<Subject ${characters.indexOf(character) + 1}>`)
    .join(", ");
  const timeline = [
    "[Shot 1] Live-action, cinematic.",
    characterPlacement
      ? `${characterPlacement} ${referencedCharacters.length === 1 ? "appears" : "appear"} with ${referencedCharacters.length === 1 ? "the referenced identity" : "their referenced identities"} fully preserved.`
      : "",
    usesSettingReference && settingSubjectNumber ? `The shot takes place in <Subject ${settingSubjectNumber}>.` : "",
    spokenAction,
    compactPromptText(shotPrompt),
    input.cameraInstructions && !hasAuthoredCamera ? `Camera: ${compactPromptText(input.cameraInstructions)}` : "",
    input.motionInstructions && !hasAuthoredMotion ? `Motion: ${compactPromptText(input.motionInstructions)}` : "",
  ].filter(Boolean).join(" ");
  const promptAudio = extractPromptAudio(shotPrompt);
  const soundscape = input.audioInstructions?.trim()
    ? compactPromptText(input.audioInstructions)
    : promptAudio.soundscape
      ? `${ensureSentenceEnding(promptAudio.soundscape)}${dialogue ? " The spoken dialogue remains clear and intelligible." : ""}`
      : dialogue
        ? "Natural room tone and subtle sounds from the visible action; the spoken dialogue remains clear and intelligible."
        : "Natural ambient sound and subtle sounds from the visible action.";
  const music = promptAudio.music ?? "N/A";
  const summarySubjects = [
    ...referencedCharacters.map((character) => `<Subject ${characters.indexOf(character) + 1}>`),
    ...(usesSettingReference && settingSubjectNumber ? [`<Subject ${settingSubjectNumber}>`] : []),
  ].join(", ");
  const retention = [
    ...referencedCharacters.map((character) => (
      `<Subject ${characters.indexOf(character) + 1}> (appears in [Shot 1]): fully_preserved - preserve the referenced identity, appearance, clothing, and recognizable features.`
    )),
    ...(usesSettingReference && settingSubjectNumber
      ? [`<Subject ${settingSubjectNumber}> (appears in [Shot 1]): fully_preserved - preserve the referenced environment, layout, lighting, and production design.`]
      : []),
  ];

  return [
    `subject_definitions:\n${subjectDefinitions.join("\n") || "No supplied reference subject is required to appear in this shot."}`,
    `summary:\n[reference generation] Create a single-shot target video using ${summarySubjects || "the described scene"}.`,
    `retention_analysis:\n${retention.join("\n") || "No supplied subject is required to appear in this shot; prioritize the described scene."}`,
    `detailed_description:\n${timeline}`,
    `overall_soundscape:\n${soundscape}`,
    `non_diegetic_music:\n${music}`,
  ].join("\n\n");
}

function compileMiniMaxH3ReferenceVideoPrompt(
  characters: { name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  if (!input.referenceVideoKey) {
    throw new Error("Reference-video prompt compilation requires an uploaded reference video");
  }
  const settingSubjectNumber = setting ? characters.length + 1 : null;
  const dialogue = input.dialogue?.trim();
  const replacesReferenceAudio = Boolean(input.referenceVideoKey && dialogue);
  const reusesReferenceAudio = Boolean(input.referenceVideoKey && !dialogue);
  const shotPrompt = shotPromptOnly(input.prompt);
  const visualShotPrompt = replacesReferenceAudio
    ? shotPrompt
      .replace(
        /\bclone\s+(?:the\s+)?voice\s+(?:to|and)\s+(?:just\s+|only\s+)?say\s+(?:the\s+)?exact\s+dialogue\s+provided\b[.!]?/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim()
    : shotPrompt;
  const referencedCharacters = characters.filter((character) => (
    escapedWordPattern(character.name).test(shotPrompt) ||
    /\b(?:presenter|character|woman|man|actor|person|subject|host|guest)\b/i.test(shotPrompt)
  ));
  const usesSettingReference = Boolean(
    setting && (
      escapedWordPattern(setting.name).test(shotPrompt) ||
      /\b(?:TBN|studio|control room|broadcast facility|broadcast studio|production room)\b/i.test(shotPrompt)
    ),
  );
  const subjectDefinitions = referencedCharacters.map((character) => (
    `<Subject ${characters.indexOf(character) + 1}> is ${character.name}, whose appearance and identity are defined by the supplied reference images: ${compactPromptText(character.promptDescription)}`
  ));
  if (setting && settingSubjectNumber && usesSettingReference) {
    subjectDefinitions.push(
      `<Subject ${settingSubjectNumber}> is the referenced environment: ${compactPromptText(setting.promptDescription)}`,
    );
  }
  if (input.referenceVideoKey) {
    subjectDefinitions.push(
      replacesReferenceAudio
        ? "<Video 1> is the source presenter video providing body movement, camera behavior, framing, and temporal structure. The presenter's mouth and facial speech articulation must be regenerated for the replacement dialogue."
        : "<Video 1> is the source presenter video providing the target timing, movement, camera behavior, and temporal structure.",
      replacesReferenceAudio
        ? "<Audio 1> is the synchronized source audio from <Video 1>, used only as a reference for the presenter's voice identity, tone, and speaking characteristics. Its original words must not be copied."
        : "<Audio 1> is the synchronized original audio track from <Video 1>, reused directly in the target video.",
    );
  }
  const primarySpeaker = referencedCharacters[0]
    ? `<Subject ${characters.indexOf(referencedCharacters[0]) + 1}>`
    : input.referenceVideoKey
      ? "The presenter from <Video 1>"
      : "The on-screen speaker";
  const hasOnScreenSpeech = /\b(speaks?|talks?|says?|addresses?|looks directly into (?:the )?camera)\b/i.test(shotPrompt);
  const isVoiceover = !hasOnScreenSpeech && /\b(off[- ]screen|voice[- ]?over|narration)\b/i.test(shotPrompt);
  const hasAuthoredCamera = /\bcamera\s*:/i.test(shotPrompt);
  const hasAuthoredMotion = /\bmotion\s*:/i.test(shotPrompt);
  const spokenAction = dialogue
    ? isVoiceover
      ? `${primarySpeaker} (S1) says in an off-screen voiceover: <d>[English] ${dialogue}</d> while the corresponding on-screen character's lips remain completely closed.`
      : `${primarySpeaker} (S1) says clearly at a natural speaking rate: <d>[English] ${dialogue}</d>`
    : "";
  const characterPlacement = referencedCharacters
    .map((character) => `<Subject ${characters.indexOf(character) + 1}>`)
    .join(", ");
  const timeline = [
    "[Shot 1] Live-action, cinematic.",
    characterPlacement
      ? `${characterPlacement} ${referencedCharacters.length === 1 ? "appears" : "appear"} with ${referencedCharacters.length === 1 ? "the referenced identity" : "their referenced identities"} fully preserved.`
      : "",
    usesSettingReference && settingSubjectNumber ? `The shot takes place in <Subject ${settingSubjectNumber}>.` : "",
    input.referenceVideoKey
      ? replacesReferenceAudio
        ? "Preserve the body movement, camera behavior, framing, and overall timing of <Video 1>, but replace the original mouth movement and facial speech articulation so they synchronize precisely with the supplied dialogue."
        : "Follow the timing, movement, and temporal structure of <Video 1>."
      : "",
    replacesReferenceAudio
      ? "Clone the presenter's voice characteristics from <Audio 1>, replace the original spoken content completely, and speak only the exact dialogue supplied below."
      : "",
    spokenAction,
    visualShotPrompt ? compactPromptText(visualShotPrompt) : "",
    input.cameraInstructions && !hasAuthoredCamera ? `Camera: ${compactPromptText(input.cameraInstructions)}` : "",
    input.motionInstructions && !hasAuthoredMotion ? `Motion: ${compactPromptText(input.motionInstructions)}` : "",
  ].filter(Boolean).join(" ");
  const promptAudio = extractPromptAudio(shotPrompt);
  const soundscape = input.audioInstructions?.trim()
    ? compactPromptText(input.audioInstructions)
    : promptAudio.soundscape
      ? `${ensureSentenceEnding(promptAudio.soundscape)}${dialogue ? " The spoken dialogue remains clear and intelligible." : ""}`
      : dialogue
        ? "Natural room tone and subtle sounds from the visible action; the spoken dialogue remains clear and intelligible."
        : "Natural ambient sound and subtle sounds from the visible action.";
  const music = promptAudio.music ?? "N/A";
  const taskTypes = replacesReferenceAudio
    ? "[reference generation + voice cloning + dialogue replacement]"
    : reusesReferenceAudio
      ? "[reference generation + audio reuse]"
      : "[reference generation]";
  const summarySubjects = [
    ...referencedCharacters.map((character) => `<Subject ${characters.indexOf(character) + 1}>`),
    ...(usesSettingReference && settingSubjectNumber ? [`<Subject ${settingSubjectNumber}>`] : []),
  ].join(", ");
  const retention = [
    ...referencedCharacters.map((character) => (
      `<Subject ${characters.indexOf(character) + 1}> (appears in [Shot 1]): fully_preserved - preserve the referenced identity, appearance, clothing, and recognizable features.`
    )),
    ...(usesSettingReference && settingSubjectNumber
      ? [`<Subject ${settingSubjectNumber}> (appears in [Shot 1]): fully_preserved - preserve the referenced environment, layout, lighting, and production design.`]
      : []),
    ...(input.referenceVideoKey
      ? [
        replacesReferenceAudio
          ? "<Video 1> (body movement, camera behavior, framing, and temporal structure): selectively_preserved - preserve the source performance except for mouth movement and facial speech articulation, which must be regenerated to lip-sync the supplied dialogue."
          : "<Video 1> (timing, movement, and temporal structure): fully_preserved - follow the source presenter's performance timing and motion.",
        replacesReferenceAudio
          ? "<Audio 1> (voice identity only): voice_preserved_content_replaced - clone the presenter's voice characteristics, discard the original spoken words, and generate only the supplied dialogue."
          : "<Audio 1>: copied - reuse the synchronized original audio signal without regenerating or rewriting it.",
      ]
      : []),
  ];
  const summaryAudio = replacesReferenceAudio
    ? " while cloning the presenter voice from <Audio 1> to speak only the supplied dialogue"
    : reusesReferenceAudio
      ? " while reusing <Audio 1>"
      : "";
  const outputSoundscape = replacesReferenceAudio
    ? `${soundscape} Do not copy or repeat the original spoken words from <Audio 1>.`
    : reusesReferenceAudio
      ? "Reuse <Audio 1> as the synchronized output audio."
      : soundscape;
  const outputMusic = reusesReferenceAudio
    ? "Reuse any music contained in <Audio 1> as part of the synchronized source audio."
    : music;

  return [
    `subject_definitions:\n${subjectDefinitions.join("\n") || "No supplied reference subject is required to appear in this shot."}`,
    `summary:\n${taskTypes} Create a single-shot target video using ${summarySubjects || "the described scene"}${summaryAudio}.`,
    `retention_analysis:\n${retention.join("\n") || "No supplied subject is required to appear in this shot; prioritize the described scene."}`,
    `detailed_description:\n${timeline}`,
    `overall_soundscape:\n${outputSoundscape}`,
    `non_diegetic_music:\n${outputMusic}`,
  ].join("\n\n");
}

function routeMiniMaxReferenceVideoAudio(
  workflow: Record<string, unknown>,
  generateReplacementDialogue: boolean,
): void {
  type WorkflowNode = { class_type?: unknown; inputs?: Record<string, unknown> };
  const nodes = workflow as Record<string, WorkflowNode>;
  const createVideo = Object.values(nodes).find((node) => node.class_type === "CreateVideo");
  if (!createVideo?.inputs) {
    throw new Error("MiniMax H3 reference-video workflow is missing its CreateVideo output node");
  }

  const audioNode = Object.entries(nodes).find(([, node]) => (
    node.class_type === (generateReplacementDialogue ? "VAEDecodeAudio" : "GetVideoComponents")
  ));
  if (!audioNode) {
    throw new Error(
      generateReplacementDialogue
        ? "MiniMax H3 reference-video workflow cannot output replacement dialogue because it has no VAEDecodeAudio node"
        : "MiniMax H3 reference-video workflow cannot preserve source audio because it has no GetVideoComponents node",
    );
  }

  createVideo.inputs.audio = [audioNode[0], generateReplacementDialogue ? 0 : 1];
}

function compilePrompt(
  modelFamily: string,
  characters: { name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  if (modelFamily.trim().toLowerCase() !== "minimax h3") {
    return compileGenericPrompt(characters, setting, input);
  }
  return input.referenceVideoKey
    ? compileMiniMaxH3ReferenceVideoPrompt(characters, setting, input)
    : compileMiniMaxH3StandardPrompt(characters, setting, input);
}

async function uploadMappedReferences(
  client: ComfyUIClient,
  mappings: ParameterMappings,
  characterIds: string[] = [],
  settingId?: string,
): Promise<Record<string, string>> {
  const [characterAssets, settingAssets] = await Promise.all([
    characterIds.length
      ? db
        .select()
        .from(characterAssetsTable)
        .where(inArray(characterAssetsTable.characterId, characterIds))
        .orderBy(asc(characterAssetsTable.sortOrder))
      : Promise.resolve([]),
    settingId
      ? db
        .select()
        .from(settingAssetsTable)
        .where(eq(settingAssetsTable.settingId, settingId))
        .orderBy(asc(settingAssetsTable.sortOrder))
      : Promise.resolve([]),
  ]);
  const fields: Array<readonly [string, { storageKey: string; originalName: string; mimeType: string }]> = [
    ...characterAssets.map((asset, index) => [`referenceImage${index + 1}`, asset] as const),
    ...settingAssets.map((asset, index) => [`settingImage${index + 1}`, asset] as const),
  ];
  const mapped: Record<string, string> = {};
  for (const [field, asset] of fields) {
    if (!mappings[field]) continue;
    const uploaded = await client.uploadImage({
      name: asset.originalName,
      mimeType: asset.mimeType,
      bytes: await mediaStorage.readBuffer(asset.storageKey),
    });
    mapped[field] = uploaded.name;
  }
  return mapped;
}

type ComfyOutputFile = {
  filename?: unknown;
  subfolder?: unknown;
  type?: unknown;
};

function chooseOutput(history: Record<string, unknown>): { filename: string; subfolder: string; type: string } | null {
  const first = Object.values(history)[0];
  if (!first || typeof first !== "object") return null;
  const outputs = (first as { outputs?: Record<string, Record<string, unknown>> }).outputs;
  if (!outputs) return null;
  for (const output of Object.values(outputs)) {
    for (const collectionName of ["gifs", "videos", "images"]) {
      const collection = output[collectionName];
      if (!Array.isArray(collection)) continue;
      for (const file of collection as ComfyOutputFile[]) {
        if (typeof file.filename === "string" && file.filename.match(/\.(mp4|webm|mov|mkv)$/i)) {
          return {
            filename: file.filename,
            subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
            type: typeof file.type === "string" ? file.type : "output",
          };
        }
      }
    }
  }
  return null;
}

export async function resumeActiveGenerations(): Promise<void> {
  const jobs = await db
    .select()
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.status, ["QUEUED", "RUNNING", "DOWNLOADING"]));
  for (const job of jobs) {
    if (!job.comfyPromptId || !job.comfyServerId) continue;
    const [server] = await db
      .select()
      .from(comfyServersTable)
      .where(eq(comfyServersTable.id, job.comfyServerId));
    if (!server) {
      logger.warn({ jobId: job.id, serverId: job.comfyServerId }, "Cannot resume generation: ComfyUI server is missing");
      continue;
    }
    void monitorGeneration(job.id, new ComfyUIClient(server), job.comfyPromptId);
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: "Submission was interrupted before ComfyUI returned a prompt ID.", failedAt: new Date() })
    .where(and(eq(generationJobsTable.status, "UPLOADING"), sql`${generationJobsTable.comfyPromptId} IS NULL`));
}

export async function createAndSubmitGeneration(input: GenerationRequest): Promise<GenerationJob> {
  const [characters, setting] = await Promise.all([
    input.characterIds?.length
      ? db.select().from(charactersTable).where(inArray(charactersTable.id, input.characterIds))
      : Promise.resolve([]),
    input.settingId
      ? db.select().from(settingsTable).where(eq(settingsTable.id, input.settingId))
      : Promise.resolve([]),
  ]);
  const wantsReferenceVideo = Boolean(input.referenceVideoKey);
  if (!wantsReferenceVideo && (characters.length !== input.characterIds?.length || !setting[0])) {
    throw new Error("Select characters and a setting from the current library");
  }
  const workflows = await db
    .select()
    .from(workflowTemplatesTable)
    .where(and(eq(workflowTemplatesTable.generationMode, input.generationMode), eq(workflowTemplatesTable.active, true)))
    .orderBy(desc(workflowTemplatesTable.version));
  const compatibleWorkflows = workflows.filter((candidate) => (
    wantsReferenceVideo
      ? Boolean(candidate.apiWorkflow && (candidate.mappings as ParameterMappings).referenceVideo)
      : isLongFormWorkflow(candidate)
  ));
  const servers = await db.select().from(comfyServersTable);
  const requestedServer = input.preferredServerId
    ? servers.find((server) => server.id === input.preferredServerId)
    : undefined;
  const activeJobs = await db
    .select({ comfyServerId: generationJobsTable.comfyServerId })
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.status, activeGenerationStatuses));
  const activeByServer = new Map<string, number>();
  for (const job of activeJobs) {
    if (job.comfyServerId) {
      activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
    }
  }
  const effectiveActiveCount = (server: typeof servers[number]) =>
    Math.max(activeByServer.get(server.id) ?? 0, server.activeJobCount);
  const candidates = compatibleWorkflows.flatMap((candidate, workflowIndex) =>
    servers
      .filter((server) => (
        server.enabled &&
        server.status === "ONLINE" &&
        hasRequiredTags(server.tags, candidate.compatibleServerTags)
      ))
      .map((server) => ({ workflow: candidate, server, workflowIndex })),
  );
  const selected = candidates
    .filter(({ server }) => effectiveActiveCount(server) < (server.maxConcurrentJobs ?? 1))
    .sort((a, b) => (
      Number(a.server.id !== requestedServer?.id) - Number(b.server.id !== requestedServer?.id) ||
      effectiveActiveCount(a.server) - effectiveActiveCount(b.server) ||
      a.server.queueSize - b.server.queueSize ||
      a.server.priority - b.server.priority ||
      a.workflowIndex - b.workflowIndex
    ))[0];
  const workflow = selected?.workflow ?? compatibleWorkflows[0] ?? workflows[0];
  if (!workflow?.apiWorkflow) {
    throw new Error("No active imported API workflow is configured for this generation mode");
  }
  if ((workflow.mappings as ParameterMappings).referenceVideo && !input.referenceVideoKey) {
    throw new Error("No active workflow without reference-video input is configured for this generation mode");
  }
  const apiWorkflow = workflow.apiWorkflow;
  const server = selected?.server;
  if (!server) {
    const compatibleServerNames = [...new Set(candidates.map(({ server: candidate }) => candidate.displayName))];
    if (compatibleServerNames.length > 0) {
      throw new Error(`All compatible GPUs are at their safe render capacity: ${compatibleServerNames.join(", ")}.`);
    }
    throw new Error("No healthy, compatible ComfyUI server is available. Configure and test a server first.");
  }
  try {
    return await withServerSlotLock(server.id, async () => {
    const activeJobs = await db
      .select({ id: generationJobsTable.id })
      .from(generationJobsTable)
      .where(and(eq(generationJobsTable.comfyServerId, server.id), inArray(generationJobsTable.status, activeGenerationStatuses)));
    if (Math.max(activeJobs.length, server.activeJobCount) >= (server.maxConcurrentJobs ?? 1)) {
      throw new Error(`${server.displayName} is at its safe render capacity.`);
    }
  const compiledPrompt = compilePrompt(workflow.modelFamily, characters, setting[0], input);
  const frameCount = Math.round(input.durationSeconds * input.fps);
  const [job] = await db
    .insert(generationJobsTable)
    .values({
      title: `${characters[0]?.name ?? "Reference video"} — ${setting[0]?.name ?? "Presenter"}`,
      status: "UPLOADING",
      workflowTemplateId: workflow.id,
      longFormShotId: input.longFormShotId ?? null,
      comfyServerId: server.id,
      prompt: input.prompt,
      compiledPrompt,
      negativePrompt: input.negativePrompt ?? null,
      width: input.width,
      height: input.height,
      fps: input.fps,
      frameCount,
      durationSeconds: input.durationSeconds,
      seed: input.seedMode === "FIXED" && input.seed != null ? Math.floor(input.seed) : null,
      generationMode: input.generationMode,
      qualityPreset: input.qualityPreset,
    })
    .returning();
  await input.onJobCreated?.(job);
  if (characters.length > 0) {
    await db.insert(generationCharactersTable).values(
      characters.map((character, index) => ({ generationJobId: job.id, characterId: character.id, sortOrder: index })),
    );
  }
  if (setting[0]) {
    await db.insert(generationSettingsTable).values({ generationJobId: job.id, settingId: setting[0].id });
  }
  try {
    const client = new ComfyUIClient(server);
    const assetParameters = await uploadMappedReferences(client, workflow.mappings as ParameterMappings, input.characterIds, input.settingId);
    if (
      !wantsReferenceVideo &&
      !Object.keys(assetParameters).some((field) => /^referenceImage\d+$/.test(field))
    ) {
      throw new Error("Select a character with at least one reference image before generating.");
    }
    const referenceVideo = input.referenceVideoKey
      ? await mediaStorage.readReferenceVideo(input.referenceVideoKey)
      : null;
    const referenceVideoParameters = referenceVideo
      ? { referenceVideo: (await client.uploadVideo(referenceVideo)).name }
      : {};
    const submittedWorkflow = buildWorkflow(apiWorkflow, workflow.mappings as ParameterMappings, {
      prompt: compiledPrompt,
      negativePrompt: input.negativePrompt,
      width: input.width,
      height: input.height,
      frames: frameCount,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
      seed: input.seedMode === "FIXED" ? input.seed ?? 0 : Math.floor(Math.random() * 2_147_483_647),
      ...assetParameters,
      ...referenceVideoParameters,
    });
    if (referenceVideo && workflow.modelFamily.trim().toLowerCase() === "minimax h3") {
      routeMiniMaxReferenceVideoAudio(submittedWorkflow, Boolean(input.dialogue?.trim()));
    }
    const submitted = await client.submitWorkflow(submittedWorkflow, job.id);
    const [queuedJob] = await db
      .update(generationJobsTable)
      .set({ status: "QUEUED", comfyPromptId: submitted.prompt_id, queuedAt: new Date() })
      .where(eq(generationJobsTable.id, job.id))
      .returning();
    void monitorGeneration(job.id, client, submitted.prompt_id);
    return queuedJob;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation submission failed";
    await db
      .update(generationJobsTable)
      .set({ status: "FAILED", errorMessage: message, failedAt: new Date() })
      .where(eq(generationJobsTable.id, job.id));
    throw error;
  }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("safe render capacity") || (input.preferredServerId && message.includes("being reserved by another render"))) {
      logger.info(
        { preferredServerId: input.preferredServerId, rejectedServer: server.displayName },
        "GPU unavailable; retrying generation on another compatible server",
      );
      return createAndSubmitGeneration({ ...input, preferredServerId: undefined });
    }
    throw error;
  }
}

export async function cancelGeneration(jobId: string) {
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, jobId));
  if (!job) {
    throw new Error("Generation job not found");
  }
  const alreadyCancelled = job.status === "CANCELLED";
  if (!activeGenerationStatuses.includes(job.status) && !alreadyCancelled) {
    throw new Error("Only active generation jobs can be cancelled");
  }

  let cancellationNote = "Cancelled by user.";
  if (job.comfyServerId && job.comfyPromptId) {
    const [server] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, job.comfyServerId));
    if (server) {
      try {
        const client = new ComfyUIClient(server);
        await client.removeQueuedPrompt(job.comfyPromptId);
        if (job.status === "RUNNING" || alreadyCancelled) {
          await client.interrupt(job.comfyPromptId);
        }
      } catch (error) {
        logger.warn({ err: error, jobId }, "Could not cancel generation on ComfyUI worker");
        cancellationNote = "Cancelled in OBTV. The ComfyUI worker could not be reached to confirm cancellation.";
      }
    }
  }

  if (alreadyCancelled) {
    const [retried] = await db
      .update(generationJobsTable)
      .set({ errorMessage: cancellationNote })
      .where(eq(generationJobsTable.id, jobId))
      .returning();
    return retried ?? job;
  }

  const [cancelled] = await db
    .update(generationJobsTable)
    .set({ status: "CANCELLED", currentNode: null, errorMessage: cancellationNote })
    .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
    .returning();
  if (!cancelled) {
    throw new Error("Generation job finished before it could be cancelled");
  }
  return cancelled;
}

async function downloadCompletedOutput(
  jobId: string,
  client: ComfyUIClient,
  promptId: string,
  allowTimedOutFailure = false,
): Promise<boolean> {
  const history = await client.getHistory(promptId);
  const output = chooseOutput(history);
  if (!output) return false;

  const eligibleStatus = allowTimedOutFailure
    ? or(
      inArray(generationJobsTable.status, activeGenerationStatuses),
      and(eq(generationJobsTable.status, "FAILED"), eq(generationJobsTable.errorMessage, generationTimeoutMessage)),
    )
    : inArray(generationJobsTable.status, activeGenerationStatuses);
  const [downloading] = await db
    .update(generationJobsTable)
    .set({ status: "DOWNLOADING", currentNode: "Retrieving output", errorMessage: null })
    .where(and(eq(generationJobsTable.id, jobId), eligibleStatus))
    .returning({ id: generationJobsTable.id });
  if (!downloading) return false;

  try {
    const bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
    const mimeType = output.filename.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
    const storageKey = await mediaStorage.storeOutput(output.filename, mimeType, bytes);
    await db
      .update(generationJobsTable)
      .set({
        status: "COMPLETED",
        outputStorageKey: storageKey,
        outputMimeType: mimeType,
        progress: 1,
        currentNode: null,
        errorMessage: null,
        failedAt: null,
        completedAt: new Date(),
      })
      .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
    return true;
  } catch (error) {
    await db
      .update(generationJobsTable)
      .set({
        status: allowTimedOutFailure ? "FAILED" : "RUNNING",
        currentNode: null,
        errorMessage: allowTimedOutFailure
          ? generationTimeoutMessage
          : error instanceof Error ? error.message : "Output download failed",
        failedAt: allowTimedOutFailure ? new Date() : null,
      })
      .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
    throw error;
  }
}

export async function recoverTimedOutGeneration(jobId: string): Promise<boolean> {
  const [job] = await db
    .select()
    .from(generationJobsTable)
    .where(eq(generationJobsTable.id, jobId));
  if (
    !job ||
    job.status !== "FAILED" ||
    job.errorMessage !== generationTimeoutMessage ||
    !job.comfyPromptId ||
    !job.comfyServerId
  ) {
    return false;
  }
  const [server] = await db
    .select()
    .from(comfyServersTable)
    .where(eq(comfyServersTable.id, job.comfyServerId));
  if (!server) return false;

  try {
    return await downloadCompletedOutput(job.id, new ComfyUIClient(server), job.comfyPromptId, true);
  } catch (error) {
    logger.warn({ err: error, jobId }, "Could not recover timed-out generation output");
    return false;
  }
}

async function monitorGeneration(jobId: string, client: ComfyUIClient, promptId: string) {
  const timeoutAt = Date.now() + generationTimeoutMs;
  const nodeProgress = new Map<string, number>();
  let lastProgressWriteAt = 0;
  let lastProgress = -1;
  let consecutiveMonitorErrors = 0;
  const persistProgress = (progress: number, currentNode: string | null) => {
    const normalized = Math.min(0.99, Math.max(0, progress));
    const now = Date.now();
    if (
      now - lastProgressWriteAt < 400 &&
      Math.abs(normalized - lastProgress) < 0.01 &&
      currentNode
    ) {
      return;
    }
    lastProgressWriteAt = now;
    lastProgress = normalized;
    void db
      .update(generationJobsTable)
      .set({ progress: normalized, currentNode })
      .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
      .catch((error) => logger.warn({ err: error, jobId }, "Could not persist ComfyUI progress"));
  };

  let disconnectProgress: (() => void) | null = null;
  try {
    disconnectProgress = client.connectProgress(jobId, (message) => {
      const data = message.data;
      if (!data || typeof data !== "object") return;
      const payload = data as Record<string, unknown>;
      if (typeof payload.prompt_id === "string" && payload.prompt_id !== promptId) return;

      if (message.type === "execution_start") {
        persistProgress(0, "ComfyUI processing");
        return;
      }

      if (message.type === "progress") {
        const value = typeof payload.value === "number" ? payload.value : null;
        const max = typeof payload.max === "number" ? payload.max : null;
        if (value === null || max === null || max <= 0) return;
        const node = typeof payload.node === "string" ? payload.node : "current";
        nodeProgress.set(node, Math.min(1, Math.max(0, value / max)));
        persistProgress(nodeProgress.get(node) ?? 0, typeof payload.node === "string" ? `ComfyUI node ${payload.node}` : "ComfyUI processing");
        return;
      }

      if (message.type === "progress_state" && payload.nodes && typeof payload.nodes === "object") {
        const entries = Object.entries(payload.nodes as Record<string, unknown>);
        if (!entries.length) return;
        let total = 0;
        let activeNode: string | null = null;
        for (const [nodeId, rawNode] of entries) {
          if (!rawNode || typeof rawNode !== "object") continue;
          const node = rawNode as Record<string, unknown>;
          const state = typeof node.state === "string" ? node.state : "";
          const value = typeof node.value === "number" ? node.value : 0;
          const max = typeof node.max === "number" && node.max > 0 ? node.max : 1;
          const nodeValue = state === "finished" ? 1 : Math.min(1, Math.max(0, value / max));
          total += nodeValue;
          if (state === "running") activeNode = nodeId;
        }
        const progress = total / entries.length;
        persistProgress(progress, activeNode ? `ComfyUI node ${activeNode}` : "ComfyUI processing");
        return;
      }

      if (message.type === "executing" && typeof payload.node === "string") {
        persistProgress(nodeProgress.get(payload.node) ?? 0, `ComfyUI node ${payload.node}`);
      }
    });
  } catch (error) {
    logger.warn({ err: error, jobId }, "ComfyUI progress WebSocket unavailable; using HTTP monitor");
  }

  try {
    while (Date.now() < timeoutAt) {
      try {
        const [currentJob] = await db
          .select({ status: generationJobsTable.status })
          .from(generationJobsTable)
          .where(eq(generationJobsTable.id, jobId));
        if (!currentJob || currentJob.status === "CANCELLED") return;
      } catch (error) {
        logger.warn({ err: error, jobId }, "Generation monitor could not read job state");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }

      try {
        if (await downloadCompletedOutput(jobId, client, promptId)) return;
        consecutiveMonitorErrors = 0;
      } catch (error) {
        consecutiveMonitorErrors += 1;
        logger.warn(
          { err: error, jobId, consecutiveMonitorErrors, maxConsecutiveMonitorErrors },
          "Generation monitor could not reach ComfyUI",
        );
        if (consecutiveMonitorErrors >= maxConsecutiveMonitorErrors) {
          const [failed] = await db
            .update(generationJobsTable)
            .set({
              status: "FAILED",
              currentNode: null,
              errorMessage: workerUnreachableMessage,
              failedAt: new Date(),
            })
            .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
            .returning({ comfyServerId: generationJobsTable.comfyServerId });
          if (failed?.comfyServerId) {
            await db
              .update(comfyServersTable)
              .set({ status: "OFFLINE" })
              .where(eq(comfyServersTable.id, failed.comfyServerId));
          }
          logger.error({ err: error, jobId, comfyServerId: failed?.comfyServerId }, workerUnreachableMessage);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }

      try {
        const [running] = await db
          .update(generationJobsTable)
          .set({ status: "RUNNING", currentNode: "ComfyUI processing" })
          .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
          .returning({ id: generationJobsTable.id });
        if (!running) return;
      } catch (error) {
        logger.warn({ err: error, jobId }, "Generation monitor could not persist running state");
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } finally {
    disconnectProgress?.();
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: generationTimeoutMessage, failedAt: new Date() })
    .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
}