import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComfyServer } from "@workspace/db";
import {
  ImageTaskError,
  submitImageTask,
} from "./image-studio-adapters";
import {
  CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE,
  CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE,
  CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE,
  CHARACTER_WORKER_CAPABILITY_CHECK_MESSAGE,
  CHARACTER_WORKER_COMPONENTS_UNAVAILABLE_MESSAGE,
  CHARACTER_WORKER_FAILURE_MESSAGE,
  characterPreparationFailureDetails,
  characterCloudSubmissionNeedsReconciliation,
  characterCloudSubmissionFailureOutcome,
  createCharacterSubmissionMetadata,
  reserveCharacterSubmissionMetadata,
  submitCharacterTaskOnce,
  characterSubmissionFailureOutcome,
  characterHistoryError,
  characterProgressFromComfyMessage,
  createCharacterProgressObserver,
  chooseCharacterReferenceAsset,
  buildPrompt,
  buildNativeReferenceEditPrompt,
  findCharacterComfyClientPromptId,
  findCharacterComfyHistoryPromptId,
  mergeCharacterProgressMetadata,
  persistCharacterProviderReceipt,
  persistCharacterAcceptedReceiptRecovery,
  markCharacterCloudSubmissionUncertain,
  reconcileCharacterCloudSettlements,
  resolveCharacterModel,
  validateCharacterModelSelection,
  selectCharacterWorker,
} from "./studio-image-generation";

function workerCandidate(
  id: string,
  overrides: Partial<ComfyServer> = {},
): ComfyServer {
  return {
    id,
    displayName: id,
    hostname: "192.0.2.1",
    apiBaseUrl: `https://${id}.example.test`,
    websocketUrl: `wss://${id}.example.test/ws`,
    gpuName: "Test GPU",
    vramGb: 24,
    tags: ["flux2-klein"],
    enabled: true,
    priority: 0,
    maxConcurrentJobs: 1,
    status: "ONLINE",
    queueSize: 0,
    activeJobCount: 0,
    memoryUsedGb: null,
    lastHeartbeat: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const nativeCapability = async (
  _modelId: string,
  _server: ComfyServer,
  _options: { referenceMode?: "latent-img2img" | "native-reference-edit" },
) => ({ nativeReferenceResizeMode: "total-pixels" as const });

test("pre-prompt preparation failures are retryable without entering uncertain reconciliation", () => {
  assert.equal(
    characterSubmissionFailureOutcome({ retryable: true }, false),
    "RETRY_PREPARATION",
  );
  assert.equal(
    characterSubmissionFailureOutcome({ retryable: true }, true),
    "UNCERTAIN",
  );
  assert.equal(
    characterSubmissionFailureOutcome(new Error("invalid model capability"), false),
    "FAILED",
  );
});

test("production Cloud create/reserve/submission transition marks the prompt before one adapter call", async () => {
  const createdMetadata = createCharacterSubmissionMetadata({
    workflow: "OBTV_Character",
    spendLifecycleVersion: 1,
  });
  assert.equal(createdMetadata.submissionIntent, false);
  assert.equal(createdMetadata.submissionPromptAttempted, false);

  const reservedMetadata = reserveCharacterSubmissionMetadata(
    createdMetadata,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(reservedMetadata.submissionIntent, true);
  assert.equal(reservedMetadata.submissionIntentAt, "2026-01-01T00:00:00.000Z");
  assert.equal(reservedMetadata.spendReserved, true);
  assert.equal(reservedMetadata.submissionPromptAttempted, false);
  assert.equal(
    characterCloudSubmissionNeedsReconciliation({
      provider: "CLOUD",
      providerRequestId: null,
      providerTaskMetadata: reservedMetadata,
    }),
    false,
  );
  const attemptedReservedMetadata = reserveCharacterSubmissionMetadata(
    { workflow: "attempted", submissionPromptAttempted: true },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(attemptedReservedMetadata.submissionPromptAttempted, true);
  const legacyReservedMetadata = reserveCharacterSubmissionMetadata(
    { workflow: "legacy", submissionIntent: true },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(legacyReservedMetadata.submissionPromptAttempted, undefined);
  assert.equal(
    characterCloudSubmissionNeedsReconciliation({
      provider: "CLOUD",
      providerRequestId: null,
      providerTaskMetadata: legacyReservedMetadata,
    }),
    true,
  );

  const state = {
    promptWasAttempted: false,
    attemptedMetadata: reservedMetadata,
  };
  let adapterCalls = 0;
  let beforeProviderSubmitReached = false;
  const receipt = {
    provider: "CLOUD" as const,
    requestId: "mock-cloud-receipt",
    metadata: {
      statusUrl: "https://queue.fal.run/requests/mock-cloud-receipt/status",
      responseUrl: "https://queue.fal.run/requests/mock-cloud-receipt",
      cancelUrl: "https://queue.fal.run/requests/mock-cloud-receipt/cancel",
    },
  } as Awaited<ReturnType<typeof submitImageTask>>;

  const submitted = await submitCharacterTaskOnce(
    async (beforeProviderSubmit) => {
      adapterCalls += 1;
      await beforeProviderSubmit();
      beforeProviderSubmitReached = true;
      return receipt;
    },
    async () => ({
      ...reservedMetadata,
      submissionPromptAttempted: true,
      submissionPromptAttemptedAt: "2026-01-01T00:00:01.000Z",
    }),
    state,
  );
  assert.equal(adapterCalls, 1);
  assert.equal(beforeProviderSubmitReached, true);
  assert.equal(state.promptWasAttempted, true);
  assert.equal(state.attemptedMetadata.submissionPromptAttempted, true);
  assert.equal(submitted.requestId, receipt.requestId);
});

test("pre-prompt preparation exposes safe source and worker capability causes", () => {
  const source = characterPreparationFailureDetails(
    new Error("ENOENT: no such file or directory, open '/var/lib/obtv-media/characters/source.jpg'"),
  );
  assert.equal(source.kind, "SOURCE_UNAVAILABLE");
  assert.equal(source.message, CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE);
  assert.equal(source.message.includes("/var/lib/obtv-media"), false);
  assert.equal(characterSubmissionFailureOutcome(new Error(source.message), false), "FAILED");

  const worker = characterPreparationFailureDetails(
    new Error(
      "FLUX.2 klein 4B is unavailable on PN A100. Required files: flux-2-klein-4b.safetensors",
    ),
  );
  assert.equal(worker.kind, "WORKER_COMPONENTS_UNAVAILABLE");
  assert.equal(worker.message, CHARACTER_WORKER_COMPONENTS_UNAVAILABLE_MESSAGE);

  const capability = characterPreparationFailureDetails({
    message: "Could not inspect local worker PN A100.",
    retryable: true,
  });
  assert.equal(capability.kind, "WORKER_CAPABILITY_CHECK");
  assert.equal(capability.message, CHARACTER_WORKER_CAPABILITY_CHECK_MESSAGE);
  assert.equal(capability.retryable, true);
});

const candidate = (
  id: string,
  label: string,
  createdAt: string,
  options: { primary?: boolean } = {},
) => ({
  id,
  storageKey: `characters/${id}.png`,
  originalName: `${id}.png`,
  mimeType: "image/png",
  label,
  isPrimary: options.primary ?? false,
  createdAt: new Date(createdAt),
});

test("native character worker selection skips invalid and throwing candidates", async () => {
  const inspected: string[] = [];
  const selected = await selectCharacterWorker(
    [workerCandidate("01-invalid"), workerCandidate("02-throws"), workerCandidate("03-valid")],
    true,
    async (_modelId, server) => {
      inspected.push(server.id);
      if (server.id === "01-invalid") return null;
      if (server.id === "02-throws") throw new Error("schema inspection failed");
      return nativeCapability(_modelId, server, { referenceMode: "native-reference-edit" });
    },
  );
  assert.deepEqual(inspected, ["01-invalid", "02-throws", "03-valid"]);
  assert.equal(selected?.server.id, "03-valid");
  assert.equal(selected?.nativeReferenceResizeMode, "total-pixels");
});

test("native character worker selection fails closed when every candidate is invalid", async () => {
  const selected = await selectCharacterWorker(
    [workerCandidate("01"), workerCandidate("02")],
    true,
    async () => null,
  );
  assert.equal(selected, null);
});

test("native character worker selection uses a stable server-id tie break", async () => {
  const selected = await selectCharacterWorker(
    [workerCandidate("worker-b"), workerCandidate("worker-a")],
    true,
    nativeCapability,
  );
  assert.equal(selected?.server.id, "worker-a");
});

test("native character worker selection filters offline and at-capacity candidates", async () => {
  const inspected: string[] = [];
  const selected = await selectCharacterWorker(
    [
      workerCandidate("offline", { status: "OFFLINE" }),
      workerCandidate("at-capacity", { activeJobCount: 1 }),
      workerCandidate("available"),
    ],
    true,
    async (_modelId, server) => {
      inspected.push(server.id);
      return nativeCapability(_modelId, server, { referenceMode: "native-reference-edit" });
    },
  );
  assert.deepEqual(inspected, ["available"]);
  assert.equal(selected?.server.id, "available");
});

test("character source selection preserves the marked original over generated profiles", () => {
  const original = candidate("maya-original", "headshot", "2025-01-01T00:00:00.000Z", { primary: true });
  const generatedProfile = candidate("generated-profile", "profile", "2025-01-02T00:00:00.000Z");
  assert.equal(
    chooseCharacterReferenceAsset(
      [generatedProfile, original],
      "/api/media/characters/generated-profile.png",
    )?.id,
    "maya-original",
  );
});

test("character source selection falls back to thumbnail and then oldest non-wardrobe", () => {
  const wardrobe = candidate("wardrobe", "wardrobe", "2024-01-01T00:00:00.000Z");
  const oldest = candidate("oldest", "other", "2024-02-01T00:00:00.000Z");
  const newest = candidate("newest", "profile", "2024-03-01T00:00:00.000Z");
  assert.equal(
    chooseCharacterReferenceAsset([newest, wardrobe, oldest], "/api/media/characters/newest.png")?.id,
    "newest",
  );
  assert.equal(
    chooseCharacterReferenceAsset([newest, wardrobe, oldest], null)?.id,
    "oldest",
  );
});

test("an explicit missing character source fails closed instead of falling back", () => {
  assert.throws(
    () => chooseCharacterReferenceAsset(
      [candidate("original", "headshot", "2025-01-01T00:00:00.000Z")],
      null,
      "deleted-source",
    ),
    /reference asset not found/i,
  );
});

test("character prompts use the requested view without a conflicting universal pose", () => {
  const entity = {
    name: "Maya",
    description: "A precise investigator.",
    promptDescription: "A production character reference.",
  };
  const headshot = buildPrompt("character", entity, "studio portrait", "headshot");
  assert.match(headshot, /headshot framing, front-facing/i);
  assert.doesNotMatch(headshot, /full body visible/i);
  assert.doesNotMatch(headshot, /looking toward camera/i);

  const profile = buildPrompt("character", entity, "studio portrait", "profile");
  assert.match(profile, /full 90-degree side profile/i);
  assert.match(profile, /exactly one eye visible/i);
  assert.doesNotMatch(profile, /front-facing stance/i);

  const threeQuarter = buildPrompt("character", entity, "studio portrait", "three-quarter");
  assert.match(threeQuarter, /45-degree three-quarter view/i);
  assert.match(threeQuarter, /same person as that original/i);
  assert.match(threeQuarter, /face, hair, skin tone, and wardrobe/i);
});

test("native source prompts are concise visual edits and preserve only explicit user additions", () => {
  const sourceProfile = buildNativeReferenceEditPrompt(undefined, "profile");
  assert.match(sourceProfile, /same unchanged subject/i);
  assert.match(sourceProfile, /hair texture, hair length, hair part/i);
  assert.match(sourceProfile, /strict 90-degree left-facing side profile/i);
  assert.match(sourceProfile, /exactly one eye visible/i);
  assert.match(sourceProfile, /nose and chin silhouette/i);
  assert.match(sourceProfile, /far eye hidden/i);
  assert.match(sourceProfile, /shoulders side-on/i);
  assert.doesNotMatch(sourceProfile, /female podcast host/i);
  assert.doesNotMatch(sourceProfile, /cream blouse/i);
  assert.doesNotMatch(sourceProfile, /production character reference/i);

  const sourceHeadshot = buildNativeReferenceEditPrompt("Add a subtle smile", "headshot");
  assert.match(sourceHeadshot, /headshot, front-facing/i);
  assert.match(sourceHeadshot, /Additional user edit instruction: Add a subtle smile/i);
  assert.match(sourceHeadshot, /new clothing/i);
  assert.doesNotMatch(sourceHeadshot, /guarantee|guaranteed/i);

  const sourceThreeQuarter = buildNativeReferenceEditPrompt(undefined, "three-quarter");
  assert.match(sourceThreeQuarter, /explicit 45-degree three-quarter view/i);
});

test("wardrobe prompts describe worn clothing rather than a wardrobe environment", () => {
  const sourceFree = buildPrompt(
    "character",
    {
      name: "Maya",
      description: "A precise investigator.",
      promptDescription: "A tailored navy suit.",
    },
    undefined,
    "wardrobe",
  );
  assert.match(sourceFree, /full-length, head-to-toe outfit\/costume continuity reference/i);
  assert.match(sourceFree, /feet and shoes fully visible/i);
  assert.match(sourceFree, /wardrobe means clothing worn by the person/i);
  assert.match(sourceFree, /plain uncluttered backdrop/i);
  assert.doesNotMatch(sourceFree, /wardrobe framing/i);

  const nativeWardrobe = buildNativeReferenceEditPrompt(undefined, "wardrobe");
  assert.match(nativeWardrobe, /full-length, head-to-toe outfit\/costume continuity reference/i);
  assert.match(nativeWardrobe, /feet and shoes fully visible/i);
  assert.match(nativeWardrobe, /retain the original identity and all visible outfit details/i);
  assert.match(nativeWardrobe, /plain\/source backdrop/i);
  assert.doesNotMatch(nativeWardrobe, /wardrobe framing/i);
});

test("native wardrobe prompts retain explicit outfit and environment edits", () => {
  const prompt = buildNativeReferenceEditPrompt(
    "Change the outfit to a red evening gown and place the person inside an actual closet.",
    "wardrobe",
  );
  assert.match(prompt, /retain the original identity and all visible outfit details unless the explicit additional edit requests an outfit change/i);
  assert.match(prompt, /Additional user edit instruction: Change the outfit to a red evening gown and place the person inside an actual closet\./i);
  assert.match(prompt, /unless the explicit additional edit requests an actual closet or other environment/i);
});

test("text-only character prompts retain saved description behavior", () => {
  const textOnly = buildPrompt(
    "character",
    {
      name: "Avery",
      description: "Female podcast host in a cream blouse.",
      promptDescription: "Female podcast host in a cream blouse.",
    },
    "A studio portrait",
    "headshot",
  );
  assert.match(textOnly, /Female podcast host in a cream blouse/i);
  assert.match(textOnly, /Character: Avery/i);
});

test("submission reconciliation finds a durable client marker in queue and history", () => {
  const marker = "job-marker";
  assert.equal(
    findCharacterComfyClientPromptId([
      [1, "prompt-queue", {}, { client_id: marker }],
    ], marker),
    "prompt-queue",
  );
  assert.equal(
    findCharacterComfyHistoryPromptId({
      "prompt-history": {
        prompt: [1, "prompt-history", {}, { client_id: marker }],
      },
    }, marker),
    "prompt-history",
  );
});

test("worker history exposes a stable public error and keeps raw details internal", () => {
  const publicMessage = characterHistoryError({
    "prompt-id": {
      status: {
        status_str: "error",
        messages: [["execution_error", { detail: "private node payload" }]],
      },
    },
  }, "prompt-id");
  assert.equal(publicMessage, CHARACTER_WORKER_FAILURE_MESSAGE);
  assert.equal(publicMessage?.includes("private node payload"), false);
  assert.equal(
    CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE.includes("duplicate"),
    true,
  );
});

test("character progress ignores messages for another prompt and reports sampler percentage", () => {
  const metadata = { progressNodes: { sampler: ["sampler-a"], saving: ["save-a"] } };
  const message = {
    type: "progress",
    data: { prompt_id: "other-prompt", node: "sampler-a", value: 2, max: 4 },
  };
  assert.equal(characterProgressFromComfyMessage(message, "character-prompt", metadata), null);
  assert.deepEqual(
    characterProgressFromComfyMessage({
      ...message,
      data: { ...message.data, prompt_id: "character-prompt" },
    }, "character-prompt", metadata),
    {
      progress: 0.5,
      progressStage: "rendering",
      progressStep: 2,
      progressTotalSteps: 4,
    },
  );
});

test("character progress metadata merge preserves durable submission markers", () => {
  const merged = mergeCharacterProgressMetadata({
    submissionIntent: true,
    submissionPromptAttempted: true,
    submissionPreparationClaimId: "claim",
  }, {
    progress: 0.75,
    progressStage: "rendering",
    progressStep: 3,
    progressTotalSteps: 4,
    progressUpdatedAt: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(merged.submissionIntent, true);
  assert.equal(merged.submissionPromptAttempted, true);
  assert.equal(merged.submissionPreparationClaimId, "claim");
  assert.equal(merged.progress, 0.75);
});

test("character progress observer reconnects without inventing a percentage and cleans up terminal sockets", async () => {
  let active = true;
  let connectCount = 0;
  let closeCount = 0;
  let disconnect: (() => void) | undefined;
  let runningFallbacks = 0;
  const persisted: Array<Record<string, unknown>> = [];
  const observer = createCharacterProgressObserver({
    clientId: "durable-job",
    promptId: "provider-prompt",
    metadata: { progress: null, progressStage: "preparing" },
    reconnectDelayMs: 5,
    persistIntervalMs: 1,
    connectProgress: (_clientId, onMessage, onDisconnect) => {
      connectCount += 1;
      disconnect = onDisconnect;
      queueMicrotask(() => onMessage({
        type: "progress",
        data: { prompt_id: "provider-prompt", node: "11", value: 2, max: 4 },
      }));
      return () => {
        closeCount += 1;
        disconnect = undefined;
      };
    },
    isActive: async () => active,
    persist: (patch) => {
      persisted.push(patch);
    },
    markRunning: () => {
      runningFallbacks += 1;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(connectCount, 1);
  assert.equal(persisted[0]?.progress, 0.5);
  disconnect?.();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(runningFallbacks, 1);
  assert.equal(connectCount, 2);
  active = false;
  observer.stop();
  assert.equal(closeCount, 2);
});

test("character progress observer does not acquire a socket after stop during active check", async () => {
  let resolveActive!: (active: boolean) => void;
  let connectCount = 0;
  const observer = createCharacterProgressObserver({
    clientId: "pending-job",
    promptId: "provider-prompt",
    metadata: {},
    connectProgress: () => {
      connectCount += 1;
      return () => undefined;
    },
    isActive: () => new Promise<boolean>((resolve) => {
      resolveActive = resolve;
    }),
    persist: () => undefined,
    markRunning: () => undefined,
  });
  observer.stop();
  resolveActive(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connectCount, 0);
});

test("character progress observer disposes errored sockets before reconnecting", async () => {
  let active = true;
  let connectCount = 0;
  let closeCount = 0;
  let reportDisconnect: (() => void) | undefined;
  const observer = createCharacterProgressObserver({
    clientId: "errored-job",
    promptId: "provider-prompt",
    metadata: {},
    reconnectDelayMs: 5,
    connectProgress: (_clientId, _onMessage, onDisconnect) => {
      connectCount += 1;
      reportDisconnect = onDisconnect;
      return () => {
        closeCount += 1;
      };
    },
    isActive: async () => active,
    persist: () => undefined,
    markRunning: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  reportDisconnect?.();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(connectCount, 2);
  assert.equal(closeCount, 1);
  active = false;
  observer.stop();
  assert.equal(closeCount, 2);
});

test("character model selection allowlist requires explicit confirmed Cloud", () => {
  assert.equal(resolveCharacterModel().id, "local-flux2-klein-4b");
  assert.equal(
    validateCharacterModelSelection("cloud-nano-banana-pro", true).provider,
    "CLOUD",
  );
  assert.throws(
    () => validateCharacterModelSelection("local-qwen-image-2512", true),
    /supports FLUX\.2 klein 4B or explicit Nano Banana Pro/i,
  );
  assert.throws(
    () => validateCharacterModelSelection("cloud-nano-banana-pro", false),
    /Confirm this paid Cloud job/i,
  );
});

test("local worker failure does not select or invoke Cloud fallback", async () => {
  let capabilityChecks = 0;
  const selected = await selectCharacterWorker(
    [workerCandidate("local-only")],
    true,
    async () => {
      capabilityChecks += 1;
      throw new Error("offline local capability failure");
    },
  );
  assert.equal(selected, null);
  assert.equal(capabilityChecks, 1);
  assert.equal(resolveCharacterModel().id, "local-flux2-klein-4b");
});

test("production receipt persistence retries a failed write with the accepted provider receipt", async () => {
  const receipt = {
    provider: "CLOUD" as const,
    requestId: "accepted-provider-request",
    metadata: {
      statusUrl: "https://queue.fal.run/requests/accepted-provider-request/status",
      responseUrl: "https://queue.fal.run/requests/accepted-provider-request",
    },
  } as Awaited<ReturnType<typeof submitImageTask>>;
  const attempts: Array<{
    fallback: boolean;
    requestId: string;
    metadata: Record<string, unknown>;
  }> = [];
  const acceptedJob = {
    id: "receipt-retry-job",
    provider: "CLOUD",
    providerRequestId: receipt.requestId,
  } as never;
  const persisted = await persistCharacterProviderReceipt(
    "receipt-retry-job",
    receipt,
    async (fallback, patch) => {
      attempts.push({
        fallback,
        requestId: patch.providerRequestId,
        metadata: patch.metadata,
      });
      if (!fallback) throw new Error("simulated first receipt-write failure");
      return acceptedJob;
    },
  );
  assert.equal(persisted?.providerRequestId, receipt.requestId);
  assert.deepEqual(attempts.map((attempt) => attempt.fallback), [false, true]);
  assert.equal(attempts[1]?.requestId, receipt.requestId);
  assert.deepEqual(attempts[1]?.metadata, receipt.metadata);
  assert.equal(
    characterCloudSubmissionNeedsReconciliation({
      provider: "CLOUD",
      providerRequestId: null,
      providerTaskMetadata: {
        submissionIntent: true,
        submissionPromptAttempted: true,
      },
    }),
    true,
  );
  assert.equal(
    characterCloudSubmissionNeedsReconciliation({
      provider: "CLOUD",
      providerRequestId: receipt.requestId,
      providerTaskMetadata: {
        submissionIntent: true,
        submissionPromptAttempted: true,
      },
    }),
    false,
  );
});

test("accepted receipt recovery keeps the durable job RUNNING for receipt-only monitoring", async () => {
  const receipt = {
    provider: "CLOUD" as const,
    requestId: "accepted-recovery-request",
    metadata: {
      statusUrl: "https://queue.fal.run/requests/accepted-recovery-request/status",
      responseUrl: "https://queue.fal.run/requests/accepted-recovery-request",
      cancelUrl: "https://queue.fal.run/requests/accepted-recovery-request/cancel",
    },
  } as Awaited<ReturnType<typeof submitImageTask>>;
  let recoveredPatch: Record<string, unknown> | undefined;
  const recovered = await persistCharacterAcceptedReceiptRecovery(
    "accepted-recovery-job",
    receipt,
    async (_fallback, patch) => {
      recoveredPatch = patch;
      return {
        id: "accepted-recovery-job",
        status: patch.status,
        providerRequestId: patch.providerRequestId,
      } as never;
    },
  );
  assert.equal(recovered?.status, "RUNNING");
  assert.equal(recovered?.providerRequestId, receipt.requestId);
  assert.equal(recoveredPatch?.status, "RUNNING");
  assert.equal(recoveredPatch?.providerRequestId, receipt.requestId);
  assert.deepEqual(recoveredPatch?.metadata, receipt.metadata);
});

test("production uncertain transition terminalizes missing Cloud receipts without resubmission", async () => {
  let persisted: {
    status: string;
    errorMessage: string;
    providerTaskMetadata: Record<string, unknown>;
  } | undefined;
  await markCharacterCloudSubmissionUncertain(
    "uncertain-job",
    { submissionIntent: true, submissionPromptAttempted: true },
    async (patch) => {
      persisted = patch;
    },
  );
  assert.equal(persisted?.status, "FAILED");
  assert.equal(persisted?.errorMessage, CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE);
  assert.equal(persisted?.providerTaskMetadata.submissionOutcomeUnknown, true);
  assert.equal(persisted?.providerTaskMetadata.submissionPromptAttempted, true);
});

test("Cloud submission failures release only validated non-timeout 4xx rejections", () => {
  assert.equal(
    characterCloudSubmissionFailureOutcome(new ImageTaskError("bad request", false, { status: 400 })),
    "RELEASED",
  );
  assert.equal(
    characterCloudSubmissionFailureOutcome(new ImageTaskError("request timeout", true, { status: 408 })),
    "UNCERTAIN",
  );
  assert.equal(
    characterCloudSubmissionFailureOutcome(new ImageTaskError("throttled", true, { status: 429 })),
    "RELEASED",
  );
  assert.equal(
    characterCloudSubmissionFailureOutcome(new ImageTaskError("server error", true, { status: 500 })),
    "UNCERTAIN",
  );
  assert.equal(characterCloudSubmissionFailureOutcome(new Error("Cloud returned an invalid response.")), "UNCERTAIN");
  assert.equal(characterCloudSubmissionFailureOutcome(new Error("Cloud returned an invalid status URL.")), "UNCERTAIN");
});

test("persistent receipt-write failure leaves the production job on reconciliation, not resubmission", async () => {
  const attempts: boolean[] = [];
  await assert.rejects(
    persistCharacterProviderReceipt(
      "receipt-failure-job",
      {
        provider: "CLOUD",
        requestId: "accepted-but-unpersisted",
        metadata: {
          statusUrl: "https://queue.fal.run/requests/accepted-but-unpersisted/status",
        },
      } as Awaited<ReturnType<typeof submitImageTask>>,
      async (fallback) => {
        attempts.push(fallback);
        throw new Error("persistent database outage");
      },
    ),
    /persistent database outage/,
  );
  assert.deepEqual(attempts, [false, true]);
  assert.equal(
    characterCloudSubmissionNeedsReconciliation({
      provider: "CLOUD",
      providerRequestId: null,
      providerTaskMetadata: {
        submissionIntent: true,
        submissionPromptAttempted: true,
        submissionOutcomeUnknown: true,
      },
    }),
    true,
  );
});

test("production Cloud settlement reconciliation retries a transient settlement after restart", async () => {
  const baseJob = {
    id: "settlement-retry-job",
    provider: "CLOUD" as const,
    providerRequestId: "accepted-provider-request",
    status: "FAILED" as const,
    providerTaskMetadata: {
      spendLifecycleVersion: 1,
      submissionPromptAttempted: true,
      spendReserved: true,
    },
  };
  let settlementAttempts = 0;
  const persistedPatches: Record<string, unknown>[] = [];
  const dependencies = {
    settle: async () => {
      settlementAttempts += 1;
      if (settlementAttempts === 1) throw new Error("temporary spending database outage");
    },
    persist: async (_jobId: string, patch: Record<string, unknown>) => {
      persistedPatches.push(patch);
    },
  };
  await reconcileCharacterCloudSettlements([baseJob], dependencies);
  assert.equal(settlementAttempts, 1);
  assert.equal(persistedPatches[0]?.spendSettlementPending, true);

  const recoveredJob = {
    ...baseJob,
    providerTaskMetadata: {
      ...baseJob.providerTaskMetadata,
      ...persistedPatches[0],
    },
  };
  await reconcileCharacterCloudSettlements([recoveredJob], dependencies);
  assert.equal(settlementAttempts, 2);
  assert.equal(persistedPatches[1]?.spendSettlementPending, false);
  assert.equal(typeof persistedPatches[1]?.spendSettledAt, "string");
});

test("production terminal settlement reconciliation chooses release, uncertainty, and completion outcomes", async () => {
  const outcomes: string[] = [];
  await reconcileCharacterCloudSettlements(
    [
      {
        id: "pre-provider-terminal",
        provider: "CLOUD",
        providerRequestId: null,
        status: "FAILED",
        providerTaskMetadata: {
          spendLifecycleVersion: 1,
        },
      },
      {
        id: "accepted-provider-terminal",
        provider: "CLOUD",
        providerRequestId: "provider-request",
        status: "FAILED",
        providerTaskMetadata: {
          spendLifecycleVersion: 1,
        },
      },
      {
        id: "completed-provider-terminal",
        provider: "CLOUD",
        providerRequestId: "provider-request",
        status: "COMPLETED",
        providerTaskMetadata: {
          spendLifecycleVersion: 1,
          finalizedAt: new Date().toISOString(),
        },
      },
    ],
    {
      settle: async (_sourceType, _sourceId, outcome) => {
        outcomes.push(outcome);
      },
      persist: async () => undefined,
    },
  );
  assert.deepEqual(outcomes, ["released", "uncertain", "estimated"]);
});
