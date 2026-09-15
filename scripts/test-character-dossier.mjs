// Run only after the development HTTPS UI and API are ready:
//   node scripts/test-character-dossier.mjs
//
// This is an isolated integration/browser regression harness for the
// Characters producer-workspace dossier contract. It authenticates through
// the real HTTPS preview before making API calls, uses only real uploaded
// bytes, and never submits an image or video generation request.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
const runId = randomUUID();
const fixtures = [];
const characterIds = [];
let browser;

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAwMDAAAwBAAEGAPr9C8cAAAAASUVORK5CYII=",
  "base64",
);
const replacementPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAAC1HAwCAAAAEElEQVR42mNk+M/wHwAE/wJ/l9K8WQAAAABJRU5ErkJggg==",
  "base64",
);

function silentWav(seconds = 5, sampleRate = 24_000) {
  const dataSize = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}


const tinyWav = silentWav();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function bodyError(response) {
  if (typeof response.body === "string") return response.body;
  return response.body?.error ?? JSON.stringify(response.body);
}

function isFormDataBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function isBinaryBody(body) {
  return Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

async function api(account, requestPath, options = {}) {
  const body = options.body;
  const headers = {
    origin,
    ...(
      body !== undefined
      && !isFormDataBody(body)
      && !isBinaryBody(body)
      && !options.headers?.["content-type"]
      && !options.headers?.["Content-Type"]
        ? { "content-type": "application/json" }
        : {}
    ),
    ...options.headers,
  };
  const requestOptions = { ...options, headers };
  // Playwright's API request context shares the cookie jar populated by the
  // real preview login above. This deliberately avoids manufacturing a
  // browser cookie or bypassing the authentication flow. Its request API
  // calls the payload `data`, whereas Node fetch calls it `body`.
  const response = account.browserContext
    ? await account.browserContext.request.fetch(`${origin}/api${requestPath}`, {
      ...requestOptions,
      ...(body === undefined ? {} : { data: body }),
      body: undefined,
    })
    : await fetch(`${origin}/api${requestPath}`, requestOptions);
  const status = typeof response.status === "function" ? response.status() : response.status;
  const text = status === 204 ? "" : await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status, body: parsed };
}

function assertStatus(response, expected, context) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(
    statuses.includes(response.status),
    `${context} should return ${statuses.join("/")}; got ${response.status}: ${bodyError(response)}`,
  );
}

function assertRejected(response, statuses, context) {
  assertStatus(response, statuses, context);
}

function passwordHash(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(
      password,
      salt,
      64,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) {
          reject(error);
          return;
        }
        resolve([
          "scrypt",
          "v1",
          16_384,
          8,
          1,
          salt.toString("base64url"),
          derived.toString("base64url"),
        ].join("$"));
      },
    );
  });
}

async function createAccount(label) {
  const suffix = runId.replaceAll("-", "").slice(0, 16);
  const userId = `character-dossier-${suffix}-${label.toLowerCase()}`;
  const email = `${label.toLowerCase()}.${suffix}@character-dossier.test`;
  // This password is used only by the browser-origin login below. It is never
  // printed, sent through a direct API shortcut, or read from process secrets.
  const password = `Dossier fixture ${suffix} ${label} password!`;
  const hashedPassword = await passwordHash(password);
  await pool.query(
    `INSERT INTO obtv_users
       (id,email,password_hash,display_name,site_role)
     VALUES ($1,$2,$3,$4,'USER')`,
    [userId, email, hashedPassword, `Dossier ${label}`],
  );
  const account = {
    label,
    userId,
    email,
    password,
    tenantId: null,
    characterId: null,
    browserContext: null,
    browserPage: null,
  };
  fixtures.push(account);
  return account;
}

async function createTenant(account) {
  const tenantId = randomUUID();
  await pool.query(
    `INSERT INTO obtv_tenants (id,name,slug,created_by_user_id)
     VALUES ($1,$2,$3,$4)`,
    [
      tenantId,
      `Character Dossier ${account.label} ${runId.slice(0, 8)}`,
      `character-dossier-${account.label.toLowerCase()}-${runId}`,
      account.userId,
    ],
  );
  await pool.query(
    `INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role)
     VALUES ($1,$2,'OWNER')`,
    [tenantId, account.userId],
  );
  await pool.query(
    "UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2",
    [tenantId, account.userId],
  );
  account.tenantId = tenantId;
  return account;
}

async function waitForPreviewReady() {
  const timeout = Number(process.env.CHARACTER_DOSSIER_READY_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + (Number.isFinite(timeout) ? timeout : 120_000);
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/auth/config`, {
        headers: { origin },
      });
      lastStatus = String(response.status);
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`HTTPS preview did not expose /api/auth/config before timeout (last result: ${lastStatus})`);
}

async function loginThroughPreview(account) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: "domcontentloaded" });
  const email = page.getByTestId("input-sign-in-email");
  const password = page.getByTestId("input-sign-in-password");
  await email.waitFor({ state: "visible", timeout: 15_000 });
  await email.fill(account.email);
  await password.fill(account.password);
  const loginResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login",
    { timeout: 15_000 },
  );
  await page.getByTestId("button-sign-in-submit").click();
  const response = await loginResponse;
  assert.equal(response.status(), 204, `Preview login failed for ${account.label}: ${response.status()}`);
  await page.waitForURL(/\/(?:studio|characters|generate|projects)/u, { timeout: 15_000 });
  const cookie = (await context.cookies(origin)).find((candidate) => candidate.name === "obtv_session");
  assert(cookie?.value, `Preview login did not set the authenticated session cookie for ${account.label}`);
  account.browserContext = context;
  account.browserPage = page;
  return { context, page };
}

async function assertUnrelatedOriginRejected() {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: {
      origin: "https://unrelated-character-dossier.invalid",
      "content-type": "application/json",
    },
    body: jsonBody({
      email: `transport-${runId}@character-dossier.invalid`,
      password: "This is only a transport probe",
    }),
  });
  assert.equal(response.status, 403, "An unrelated browser origin must be rejected before authentication");
}

async function waitForDossierEndpoint(account, characterId) {
  const timeout = Number(process.env.CHARACTER_DOSSIER_READY_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + (Number.isFinite(timeout) ? timeout : 120_000);
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    const response = await api(account, `/characters/${characterId}/dossier`);
    lastStatus = `${response.status}: ${bodyError(response)}`;
    if (response.status === 200) return response;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authenticated dossier readiness probe was rejected: ${lastStatus}`);
    }
    await sleep(500);
  }
  throw new Error(`Character dossier endpoint was not ready before timeout (last result: ${lastStatus})`);
}

async function uploadImageStudioAsset(account, bytes, name) {
  const response = await api(account, "/image-studio/uploads", {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": "image/png",
      "x-file-name": name,
    },
  });
  assertStatus(response, 201, `Image Studio fixture upload ${name}`);
  assert(response.body?.asset?.id, "Image Studio upload did not return an asset ID");
  return response.body.asset;
}

async function uploadCharacterAsset(account, characterId, bytes, name, label, description) {
  const response = await api(account, `/characters/${characterId}/assets`, {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": "image/png",
      "x-file-name": name,
      "x-asset-label": label,
      "x-asset-description": description,
    },
  });
  assertStatus(response, 201, `Character ${label} upload`);
  return response;
}

async function createCharacter(account, label) {
  const response = await api(account, "/characters", {
    method: "POST",
    body: jsonBody({
      name: `${label} Dossier Subject`,
      description: "An isolated dossier regression fixture.",
      promptDescription: "A poised presenter with a copper scarf and short dark hair.",
      tags: ["dossier", "fixture"],
      voiceProfile: "Warm, calm delivery with measured pacing.",
    }),
  });
  assertStatus(response, 201, `${label} character creation`);
  const character = response.body?.character ?? response.body;
  assert(character?.id, `${label} character creation did not return an ID`);
  account.characterId = character.id;
  characterIds.push(character.id);
  return character;
}

function dossierBody(response) {
  return response.body?.dossier ?? response.body;
}

function assetByLabel(dossier, label) {
  return dossier.assets?.find((asset) => asset.label === label);
}

function mediaUrl(asset) {
  return asset?.mediaUrl ?? asset?.url;
}

async function runApiContract(owner, foreign) {
  const ownerCharacter = await createCharacter(owner, "Owner");
  const foreignCharacter = await createCharacter(foreign, "Foreign");
  const initialResponse = await waitForDossierEndpoint(owner, ownerCharacter.id);
  const initial = dossierBody(initialResponse);
  assert.equal(initial.status, "DRAFT");
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.wardrobes, []);

  const foreignDossier = await api(foreign, `/characters/${ownerCharacter.id}/dossier`);
  assertRejected(foreignDossier, [403, 404], "Foreign dossier GET");
  const foreignUpdate = await api(foreign, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: "Foreign overwrite",
      performanceNotes: "Must not cross the tenant boundary.",
      wardrobes: [],
      revision: 0,
    }),
  });
  assertRejected(foreignUpdate, [403, 404], "Foreign dossier PUT");

  const ownerStudioAsset = await uploadImageStudioAsset(
    owner,
    tinyPng,
    `owner-wardrobe-${runId}.png`,
  );
  const foreignStudioAsset = await uploadImageStudioAsset(
    foreign,
    tinyPng,
    `foreign-wardrobe-${runId}.png`,
  );
  const wardrobe = {
    id: `wardrobe-${runId}`,
    name: "Indigo Field Jacket",
    description: "Indigo field jacket with a copper scarf.",
    referenceAssetId: ownerStudioAsset.id,
  };
  const invalidOwnership = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: "Lead presenter",
      performanceNotes: "Measured, observant, and calm between takes.",
      wardrobes: [{ ...wardrobe, referenceAssetId: foreignStudioAsset.id }],
      revision: 0,
    }),
  });
  assertRejected(invalidOwnership, [400, 403, 404], "Cross-tenant wardrobe Image Studio asset");

  const firstPut = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: "Lead presenter",
      performanceNotes: "Measured, observant, and calm between takes.",
      wardrobes: [wardrobe],
      revision: 0,
    }),
  });
  assertStatus(firstPut, 200, "Dossier role/performance/wardrobe PUT");
  const firstDossier = dossierBody(firstPut);
  assert.equal(firstDossier.role, "Lead presenter");
  assert.equal(firstDossier.performanceNotes, "Measured, observant, and calm between takes.");
  assert.deepEqual(firstDossier.wardrobes, [wardrobe]);
  assert.equal(firstDossier.status, "DRAFT");
  assert.equal(firstDossier.revision, 1);
  assert.equal(firstDossier.approvedAt, null);

  const stalePut = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: "Stale overwrite",
      performanceNotes: "This must not replace the current dossier.",
      wardrobes: [wardrobe],
      revision: firstDossier.revision - 1,
    }),
  });
  assertRejected(stalePut, [409], "Stale dossier PUT revision");
  const afterStalePut = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert.equal(afterStalePut.revision, firstDossier.revision, "A stale dossier PUT must not increment revision");
  assert.equal(afterStalePut.role, firstDossier.role, "A stale dossier PUT must not overwrite role");

  // Continuity imports accept wardrobes without a reference asset. The API
  // normalizes the omitted field to null so both approved and draft consumers
  // receive a stable shape.
  const continuityWardrobe = {
    id: wardrobe.id,
    name: wardrobe.name,
    description: wardrobe.description,
  };
  const continuityDraftPut = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      wardrobes: [continuityWardrobe],
      revision: firstDossier.revision,
    }),
  });
  assertStatus(continuityDraftPut, 200, "Draft continuity wardrobe import");
  const continuityDraft = dossierBody(continuityDraftPut);
  assert.equal(continuityDraft.role, firstDossier.role, "Omitted continuity role must be preserved");
  assert.equal(
    continuityDraft.performanceNotes,
    firstDossier.performanceNotes,
    "Omitted continuity performance notes must be preserved",
  );
  assert.equal(continuityDraft.wardrobes[0].referenceAssetId, null, "No-reference wardrobe must normalize to null");

  const reloadedDossier = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert.deepEqual(
    {
      role: reloadedDossier.role,
      performanceNotes: reloadedDossier.performanceNotes,
      wardrobes: reloadedDossier.wardrobes,
      revision: reloadedDossier.revision,
    },
    {
      role: continuityDraft.role,
      performanceNotes: continuityDraft.performanceNotes,
      wardrobes: continuityDraft.wardrobes,
      revision: continuityDraft.revision,
    },
    "Dossier fields must survive a real API reload",
  );

  const headshotUpload = await uploadCharacterAsset(
    owner,
    ownerCharacter.id,
    tinyPng,
    `headshot-${runId}.png`,
    "headshot",
    "Front-facing headshot for dossier review.",
  );
  assert(headshotUpload.body?.mediaUrl, "Labeled headshot upload must return a media URL");
  const afterHeadshotUpload = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  const headshot = assetByLabel(afterHeadshotUpload, "headshot");
  assert(headshot?.id, "Dossier must expose the uploaded headshot asset");
  assert.equal(headshot.description, "Front-facing headshot for dossier review.");
  assert(mediaUrl(headshot), "Dossier headshot must expose a media URL");

  const foreignAssetUpload = await uploadCharacterAsset(
    foreign,
    foreignCharacter.id,
    tinyPng,
    `foreign-headshot-${runId}.png`,
    "headshot",
    "Foreign tenant asset.",
  );
  assert(foreignAssetUpload.body?.mediaUrl);
  const foreignAssetDossier = dossierBody(await api(foreign, `/characters/${foreignCharacter.id}/dossier`));
  const foreignHeadshot = assetByLabel(foreignAssetDossier, "headshot");
  assert(foreignHeadshot?.id, "Foreign dossier must expose its own headshot");
  const foreignAssetAsWardrobe = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: firstDossier.role,
      performanceNotes: firstDossier.performanceNotes,
      wardrobes: [{
        ...wardrobe,
        referenceAssetId: foreignHeadshot.id,
      }],
      revision: afterHeadshotUpload.revision,
    }),
  });
  assertRejected(foreignAssetAsWardrobe, [400, 403, 404], "Cross-tenant character reference as wardrobe asset");
  const mediaResponse = await owner.browserContext.request.fetch(new URL(mediaUrl(headshot), origin).toString(), {
    headers: { origin },
  });
  assert.equal(mediaResponse.status(), 200, "Authenticated owner must be able to read a headshot media URL");
  assert.match(mediaResponse.headers()["content-type"] ?? "", /^image\//i);
  const foreignMediaResponse = await foreign.browserContext.request.fetch(new URL(mediaUrl(headshot), origin).toString(), {
    headers: { origin },
  });
  assert([403, 404].includes(foreignMediaResponse.status()), "Foreign tenant must not read a headshot media URL");

  const makePrimary = await api(owner, `/characters/${ownerCharacter.id}/assets/${headshot.id}`, {
    method: "PATCH",
    body: jsonBody({ label: "headshot", description: "Primary dossier headshot.", makePrimary: true }),
  });
  assertStatus(makePrimary, 200, "Set dossier headshot primary");
  const afterPrimary = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  const primaryHeadshot = assetByLabel(afterPrimary, "headshot");
  assert(primaryHeadshot?.id, "Primary headshot must remain in dossier assets");
  const characterListAfterPrimary = await api(owner, "/characters");
  assertStatus(characterListAfterPrimary, 200, "Character list after setting primary");
  const listedOwner = (characterListAfterPrimary.body?.characters ?? characterListAfterPrimary.body)
    ?.find((candidate) => candidate.id === ownerCharacter.id);
  assert(
    listedOwner?.thumbnail === mediaUrl(primaryHeadshot)
      || listedOwner?.thumbnail?.endsWith(primaryHeadshot.mediaUrl?.split("/").pop() ?? "__missing__"),
    "Setting a primary reference must update the character thumbnail",
  );

  const appearanceUpload = await uploadCharacterAsset(
    owner,
    ownerCharacter.id,
    replacementPng,
    `profile-${runId}.png`,
    "profile",
    "Profile appearance reference for approval.",
  );
  assert(appearanceUpload.body?.mediaUrl);
  const beforeApproval = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  const appearance = assetByLabel(beforeApproval, "profile");
  assert(appearance?.id, "Dossier must expose a profile appearance reference");
  const staleRevision = Math.max(0, beforeApproval.revision - 1);
  const staleApproval = await api(owner, `/characters/${ownerCharacter.id}/dossier/approve`, {
    method: "POST",
    body: jsonBody({ revision: staleRevision }),
  });
  assertRejected(staleApproval, [409], "Stale dossier approval revision");
  const approval = await api(owner, `/characters/${ownerCharacter.id}/dossier/approve`, {
    method: "POST",
    body: jsonBody({ revision: beforeApproval.revision }),
  });
  assertStatus(approval, 200, "Dossier approval");
  const approved = dossierBody(approval);
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.revision, beforeApproval.revision);
  assert(approved.approvedAt);
  assert.equal(
    approved.wardrobes[0]?.referenceAssetId,
    null,
    "Approved continuity import must preserve no-reference wardrobe normalization",
  );

  const edited = await api(owner, `/characters/${ownerCharacter.id}/dossier`, {
    method: "PUT",
    body: jsonBody({
      role: "Lead presenter and interviewer",
      performanceNotes: "Keep eye contact with the lens and hold a calm, deliberate pace.",
      wardrobes: [{
        ...continuityWardrobe,
        description: "The same indigo jacket with a copper scarf.",
      }],
      revision: beforeApproval.revision,
    }),
  });
  assertStatus(edited, 200, "Dossier edit after approval");
  const editedDossier = dossierBody(edited);
  assert.equal(editedDossier.status, "DRAFT");
  assert.equal(editedDossier.approvedAt, null);
  assert.equal(editedDossier.revision, approved.revision + 1);
  assert.equal(
    editedDossier.wardrobes[0]?.referenceAssetId,
    null,
    "Draft continuity import must preserve no-reference wardrobe normalization",
  );

  const reapproved = await api(owner, `/characters/${ownerCharacter.id}/dossier/approve`, {
    method: "POST",
    body: jsonBody({ revision: editedDossier.revision }),
  });
  assertStatus(reapproved, 200, "Dossier reapproval before reference invalidation");
  const reapprovedDossier = dossierBody(reapproved);
  const metadataEdit = await api(owner, `/characters/${ownerCharacter.id}/assets/${appearance.id}`, {
    method: "PATCH",
    body: jsonBody({ label: "profile", description: "Updated appearance review note.", makePrimary: false }),
  });
  assertStatus(metadataEdit, 200, "Character reference metadata edit");
  const afterMetadataEdit = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert.equal(afterMetadataEdit.status, "DRAFT");
  assert.equal(afterMetadataEdit.approvedAt, null);
  assert.equal(afterMetadataEdit.revision, reapprovedDossier.revision + 1);

  const reapprovalBeforeUpload = await api(owner, `/characters/${ownerCharacter.id}/dossier/approve`, {
    method: "POST",
    body: jsonBody({ revision: afterMetadataEdit.revision }),
  });
  assertStatus(reapprovalBeforeUpload, 200, "Dossier approval after metadata edit");
  const approvedBeforeReplacementUpload = dossierBody(reapprovalBeforeUpload);
  const replacementUpload = await uploadCharacterAsset(
    owner,
    ownerCharacter.id,
    replacementPng,
    `expression-${runId}.png`,
    "expression",
    "Expression reference used to verify upload invalidation.",
  );
  assert(replacementUpload.body?.mediaUrl);
  const afterReplacementUpload = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert.equal(afterReplacementUpload.status, "DRAFT");
  assert.equal(afterReplacementUpload.approvedAt, null);
  assert.equal(afterReplacementUpload.revision, approvedBeforeReplacementUpload.revision + 1);

  const expression = assetByLabel(afterReplacementUpload, "expression");
  assert(expression?.id);
  const foreignDelete = await api(foreign, `/characters/${ownerCharacter.id}/assets/${expression.id}`, {
    method: "DELETE",
  });
  assertRejected(foreignDelete, [403, 404], "Foreign character reference delete");
  const approvedBeforeReferenceDeleteResponse = await api(owner, `/characters/${ownerCharacter.id}/dossier/approve`, {
    method: "POST",
    body: jsonBody({ revision: afterReplacementUpload.revision }),
  });
  assertStatus(approvedBeforeReferenceDeleteResponse, 200, "Dossier approval before reference deletion");
  const approvedBeforeReferenceDelete = dossierBody(approvedBeforeReferenceDeleteResponse);
  const deleteResponse = await api(owner, `/characters/${ownerCharacter.id}/assets/${expression.id}`, {
    method: "DELETE",
  });
  assertStatus(deleteResponse, 204, "Character reference delete");
  const afterDelete = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert(!afterDelete.assets.some((asset) => asset.id === expression.id), "Deleted reference must leave the dossier");
  assert.equal(afterDelete.status, "DRAFT", "Reference deletion must invalidate dossier approval");
  assert.equal(afterDelete.approvedAt, null, "Reference deletion must clear dossier approval time");
  assert.equal(afterDelete.revision, approvedBeforeReferenceDelete.revision + 1);

  const deletePrimary = await api(owner, `/characters/${ownerCharacter.id}/assets/${primaryHeadshot.id}`, {
    method: "DELETE",
  });
  assertStatus(deletePrimary, 204, "Primary headshot delete");
  const listAfterPrimaryDelete = await api(owner, "/characters");
  const deletedPrimaryCharacter = (listAfterPrimaryDelete.body?.characters ?? listAfterPrimaryDelete.body)
    ?.find((candidate) => candidate.id === ownerCharacter.id);
  assert.equal(deletedPrimaryCharacter?.thumbnail ?? null, null, "Deleting the primary must clear the thumbnail");

  const finalOwnerDossier = dossierBody(await api(owner, `/characters/${ownerCharacter.id}/dossier`));
  assert(!finalOwnerDossier.assets.some((asset) => asset.id === primaryHeadshot.id));
  assert.equal(
    (await api(foreign, `/characters/${ownerCharacter.id}/dossier`)).status,
    404,
    "Foreign tenant must not read the owner dossier after reference mutations",
  );
}

async function optionalVisibleLabel(page, patterns) {
  for (const pattern of patterns) {
    const matches = page.getByLabel(pattern);
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function optionalVisibleButton(page, patterns) {
  for (const pattern of patterns) {
    const matches = page.getByRole("button", { name: pattern });
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function optionalVisibleTab(page, patterns) {
  for (const pattern of patterns) {
    const matches = page.getByRole("tab", { name: pattern });
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  // Radix Tabs has rendered the trigger with a role=tab in some preview
  // builds and only a text-bearing button in others. Keep the fallback
  // scoped to the visible editor so a sidebar link cannot be mistaken for a
  // dossier tab.
  const renderedTabs = page.locator('[role="tab"], button');
  for (let index = 0; index < await renderedTabs.count(); index += 1) {
    const candidate = renderedTabs.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await candidate.innerText().catch(() => "");
    if (patterns.some((pattern) => pattern.test(text.trim()))) return candidate;
  }
  for (const pattern of patterns) {
    const labels = page.getByText(pattern, { exact: false });
    for (let index = 0; index < await labels.count(); index += 1) {
      const candidate = labels.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  for (const text of ["Identity & Performance", "Visual References", "Wardrobe", "Voice Cloning"]) {
    const matches = page.getByText(text, { exact: true });
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function requiredVisibleButton(page, patterns, description) {
  const button = await optionalVisibleButton(page, patterns);
  assert(button, `Character dossier UI button "${description}" was not found`);
  return button;
}

async function fillOptional(page, patterns, value) {
  const control = await optionalVisibleLabel(page, patterns);
  if (control) {
    await control.fill(value);
    return true;
  }
  return false;
}

async function setFileInput(page, patterns, file) {
  const inputs = page.locator('input[type="file"]');
  for (let index = 0; index < await inputs.count(); index += 1) {
    const candidate = inputs.nth(index);
    const name = (await candidate.getAttribute("name")) ?? "";
    const accept = (await candidate.getAttribute("accept")) ?? "";
    if (patterns.some((pattern) => pattern.test(`${name} ${accept}`))) {
      await candidate.setInputFiles(file);
      return candidate;
    }
  }
  return null;
}

async function clickDossierTab(editor, pattern, description) {
  const triggers = editor.locator("button").filter({ hasText: pattern });
  for (let index = 0; index < await triggers.count(); index += 1) {
    const trigger = triggers.nth(index);
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      return trigger;
    }
  }
  throw new Error(`Character dossier ${description} tab was not found`);
}

async function assertResponsiveLayout(page, description) {
  const layout = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const dialog = document.querySelector('[role="dialog"]');
    const offenders = [];
    const candidates = dialog
      ? [dialog, ...dialog.querySelectorAll("*")]
      : [document.body, ...document.body.querySelectorAll("*")];
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const inScrollableRegion = Boolean(element.closest(
        '[role="tablist"], .overflow-x-auto, .overflow-auto',
      ));
      const outsideViewport = !inScrollableRegion && (rect.left < -2 || rect.right > viewport + 2);
      const clippedText = element.scrollWidth > element.clientWidth + 2
        && style.whiteSpace === "nowrap"
        && rect.width > 2
        && !inScrollableRegion;
      if (outsideViewport || clippedText) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || "").trim().replace(/\s+/gu, " ").slice(0, 100),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
          whiteSpace: style.whiteSpace,
        });
      }
    }
    const dialogRect = dialog?.getBoundingClientRect();
    return {
      viewport,
      documentScrollWidth: document.documentElement.scrollWidth,
      dialog: dialogRect
        ? {
          left: Math.round(dialogRect.left),
          right: Math.round(dialogRect.right),
          width: Math.round(dialogRect.width),
        }
        : null,
      offenders: offenders.slice(0, 20),
    };
  });
  assert(layout.dialog, `${description} must expose a dossier dialog`);
  assert(
    layout.dialog.right <= layout.viewport + 2,
    `${description} dialog must fit within the viewport: ${JSON.stringify(layout)}`,
  );
  assert(
    layout.dialog.left >= -2,
    `${description} dialog must not start outside the viewport: ${JSON.stringify(layout)}`,
  );
  assert.deepEqual(
    layout.offenders,
    [],
    `${description} contains a clipped dialog/inner element or unwrapped text: ${JSON.stringify(layout)}`,
  );
  const dialog = page.getByRole("dialog").last();
  for (const pattern of [/^Save Draft$/i, /^Approve Dossier$/i]) {
    const control = dialog.getByRole("button", { name: pattern });
    assert(
      await control.count() && await control.first().isVisible().catch(() => false),
      `${description} must keep ${pattern} visible`,
    );
  }
}

function installGenerationGuard(page, attempts) {
  page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const generationPath = (
      /\/characters\/[^/]+\/generate-image$/u.test(pathname)
      || /\/image-studio\/jobs(?:\/|$)/u.test(pathname)
      || /(?:^|\/)generate(?:\/|$)/u.test(pathname)
      || /(?:^|\/)jobs(?:\/|$)/u.test(pathname)
    );
    if (request.method() === "POST" && generationPath) {
      attempts.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 418,
        contentType: "application/json",
        body: JSON.stringify({ error: "Character dossier harness blocks generation requests" }),
      });
      return;
    }
    await route.continue();
  });
}

async function generationRowCounts(account) {
  const [video, image] = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM obtv_generation_jobs WHERE tenant_id=$1", [account.tenantId]),
    pool.query("SELECT count(*)::int AS count FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]),
  ]);
  return Number(video.rows[0]?.count ?? 0) + Number(image.rows[0]?.count ?? 0);
}

async function assertImageLoaded(page, url, context) {
  const loaded = await page.evaluate((source) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    });
    image.onerror = () => resolve({ complete: image.complete, naturalWidth: 0, naturalHeight: 0 });
    image.src = source;
  }), new URL(url, origin).toString());
  assert.equal(loaded.complete, true, `${context} did not finish loading`);
  assert(loaded.naturalWidth > 0, `${context} resolved to a media 404 or empty image`);
  assert(loaded.naturalHeight > 0, `${context} has no natural height`);
}

async function openCharacterEditor(page, characterName) {
  const existingDialog = page.getByRole("dialog").last();
  if (
    await existingDialog.count()
    && await existingDialog.isVisible().catch(() => false)
    && (await existingDialog.innerText().catch(() => "")).includes(characterName)
  ) {
    return existingDialog;
  }
  const cardText = page.getByText(characterName, { exact: true }).first();
  await cardText.waitFor({ state: "visible", timeout: 10_000 });
  const card = cardText.locator("xpath=ancestor::*[.//button][1]");
  const edit = card.getByRole("button", {
    name: new RegExp(`^Edit\\s+${characterName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "i"),
  }).first();
  if (edit) {
    if (await edit.count() && await edit.isVisible().catch(() => false)) {
      await edit.click();
    } else if (await card.count()) {
      await card.click();
    } else {
      await cardText.click();
    }
  } else if (await card.count()) {
    await card.click();
  } else {
    await cardText.click();
  }
  const dialog = page.getByRole("dialog").last();
  if (await dialog.count() && await dialog.isVisible().catch(() => false)) return dialog;
  return page;
}

async function createCharacterFromUi(page, attempts) {
  await page.goto(`${origin}/characters`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Characters|Cast Library/i }).first().waitFor({ timeout: 15_000 });
  const newButton = await requiredVisibleButton(
    page,
    [/^New Character(?: Dossier)?$/i, /^Create your first character$/i, /^Create Character$/i, /^\+?\s*New$/i],
    "new character",
  );
  await newButton.click();
  const dialog = page.getByRole("dialog").last();
  if (await dialog.count()) await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  const scope = dialog.count() ? dialog : page;
  const name = await optionalVisibleLabel(scope, [/^Name$/i, /character name/i, /^Name of character$/i]);
  assert(name, "Character create UI name field was not found");
  const uiName = `UI Dossier ${runId.slice(0, 8)}`;
  await name.fill(uiName);
  await fillOptional(scope, [/short description/i, /^Description$/i], "A browser-created dossier subject.");
  await fillOptional(scope, [/character appearance/i, /prompt description/i, /appearance/i], "A poised presenter with short dark hair.");
  await fillOptional(scope, [/^Role$/i, /role in production/i, /character role/i], "Browser-created lead");
  await fillOptional(scope, [/performance notes/i, /^Performance$/i], "Keep a calm, deliberate delivery.");
  await fillOptional(scope, [/voice direction/i, /voice profile/i], "Warm, calm delivery.");

  const submit = await requiredVisibleButton(
    scope,
    [/^Create Character$/i, /^Save Character$/i, /^Save Changes$/i, /^Save Dossier$/i, /^Save Draft$/i, /^Save$/i],
    "create/save character",
  );
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/characters"
      && response.status() === 201,
    { timeout: 15_000 },
  );
  await submit.click();
  await createdResponse;
  await page.getByText(uiName, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  const owner = fixtures.find((account) => account.browserPage === page);
  assert(owner, "The browser page must belong to an authenticated fixture account");
  const listed = await api(owner, "/characters");
  const uiCharacter = (listed.body?.characters ?? listed.body)?.find((candidate) => candidate.name === uiName);
  assert(uiCharacter?.id, "Browser-created character was not returned by the authenticated API");
  characterIds.push(uiCharacter.id);
  return { id: uiCharacter.id, name: uiName, attempts };
}

async function uploadUiDossierHeadshot(page, character) {
  const editor = await openCharacterEditor(page, character.name);
  await fillOptional(editor, [/^Role$/i, /role in production/i, /character role/i], "Browser-created lead");
  await fillOptional(editor, [/performance notes/i, /^Performance$/i], "Keep a calm, deliberate delivery.");
  const wardrobeTab = await optionalVisibleTab(editor, [/^Wardrobe$/i, /^Wardrobe Library$/i]);
  assert(wardrobeTab, "Opened character dossier did not expose the wardrobe tab");
  await wardrobeTab.click();
  const addOutfit = await optionalVisibleButton(editor, [/^Add Outfit$/i, /^Create First Outfit$/i]);
  assert(addOutfit, "Opened character dossier did not expose an add-wardrobe control");
  await addOutfit.click();
  const wardrobeName = editor.getByPlaceholder(/Heist Suit|outfit/i).last();
  await wardrobeName.waitFor({ state: "visible", timeout: 5_000 });
  await wardrobeName.fill("Browser Indigo Jacket");
  const wardrobeDescription = editor.getByPlaceholder(/Detailed description|clothing|accessories|description/i).last();
  await wardrobeDescription.fill("Indigo jacket and copper scarf.");
  // Wardrobes are local react-hook-form edits. The production editor persists
  // them with its main Save Draft action rather than an outfit-level button.
  const saveDraft = await requiredVisibleButton(editor, [/^Save Draft$/i], "dossier wardrobe Save Draft");
  const characterPatchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH"
      && new URL(response.url()).pathname === `/api/characters/${character.id}`,
    { timeout: 15_000 },
  );
  const wardrobeSaveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/characters/${character.id}/dossier`,
    { timeout: 15_000 },
  );
  await saveDraft.click();
  const characterPatch = await characterPatchResponse;
  if (characterPatch.status() !== 200) {
    throw new Error(
      `Dossier Save Draft character PATCH failed (${characterPatch.status()}): ${await characterPatch.text()}`,
    );
  }
  const wardrobeSave = await wardrobeSaveResponse;
  if (wardrobeSave.status() !== 200) {
    throw new Error(
      `Dossier Save Draft dossier PUT failed (${wardrobeSave.status()}): ${await wardrobeSave.text()}`,
    );
  }

  const referencesTab = await optionalVisibleTab(editor, [/^Visual References$/i, /^References$/i]);
  assert(referencesTab, "Opened character dossier did not expose the visual references tab");
  await referencesTab.click();
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/characters/${character.id}/assets`)
      && response.status() === 201,
    { timeout: 15_000 },
  );
  const headshotInput = await setFileInput(page, [/headshot/i, /reference/i, /asset/i, /image/i], {
    name: `ui-review-headshot-${runId}.png`,
    mimeType: "image/png",
    buffer: tinyPng,
  });
  assert(headshotInput, "Opened character dossier did not expose a headshot upload control");
  // DossierReferences intentionally uses a hidden native input behind the
  // Upload Image button. setInputFiles still exercises that real browser
  // upload path without clicking any generation control.
  await uploadResponse;

  // Approval requires an appearance reference in addition to a headshot.
  // Select profile in the real UI and upload a second tiny, valid PNG.
  const viewSelect = editor.getByRole("combobox").first();
  assert(
    await viewSelect.count() && await viewSelect.isVisible().catch(() => false),
    "Opened character references did not expose the target-view selector",
  );
  await viewSelect.click();
  const profileOption = page.getByRole("option", { name: /^profile$/i }).last();
  await profileOption.waitFor({ state: "visible", timeout: 5_000 });
  await profileOption.click();
  const profileResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/characters/${character.id}/assets`)
      && response.status() === 201,
    { timeout: 15_000 },
  );
  const profileInput = await setFileInput(page, [/headshot/i, /reference/i, /asset/i, /image/i], {
    name: `ui-review-profile-${runId}.png`,
    mimeType: "image/png",
    buffer: replacementPng,
  });
  assert(profileInput, "Opened character dossier did not retain the visual reference upload control");
  await profileResponse;

  await clickDossierTab(editor, /Voice Cloning/i, "voice");
  await editor.getByText("Voice Sample Requirements", { exact: true }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  const consent = await optionalVisibleLabel(editor, [/voice.*permission/i, /permission.*clone/i]);
  assert(consent, "Character UI voice consent checkbox was not found");
  await consent.check();
  const voiceResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/characters/${character.id}/voice-sample`)
      && response.status() === 201,
    { timeout: 15_000 },
  );
  const voiceInput = await setFileInput(page, [/voice/i, /audio/i], {
    name: `ui-voice-${runId}.wav`,
    mimeType: "audio/wav",
    buffer: tinyWav,
  });
  assert(voiceInput, "Character UI voice upload input was not found");
  await voiceResponse;

  const identityTab = await optionalVisibleTab(editor, [/^Identity & Performance$/i, /^Identity$/i]);
  if (identityTab) await identityTab.click();

  const review = await optionalVisibleButton(page, [/^Review(?: headshot| references?)?$/i, /^Review dossier$/i, /^Review$/i]);
  if (review) {
    await review.click();
    const reviewDialog = page.getByRole("dialog").last();
    const image = reviewDialog.locator("img").first();
    if (await image.count()) {
      await image.waitFor({ state: "visible", timeout: 10_000 });
      const state = await image.evaluate((candidate) => ({
        complete: candidate instanceof HTMLImageElement && candidate.complete,
        naturalWidth: candidate instanceof HTMLImageElement ? candidate.naturalWidth : 0,
      }));
      assert.equal(state.complete, true, "UI dossier headshot did not finish loading");
      assert(state.naturalWidth > 0, "UI dossier headshot resolved to an empty media image");
    }
  }
  const approve = await optionalVisibleButton(page, [/^Approve(?: dossier| character| headshot)?$/i, /^Approve$/i]);
  assert(approve, "Character dossier UI approval control was not found");
  await approve.click();
  await page.waitForTimeout(150);
}

async function runBrowserUi(owner) {
  const page = owner.browserPage;
  const attempts = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  installGenerationGuard(page, attempts);
  const beforeJobs = await generationRowCounts(owner);
  const character = await createCharacterFromUi(page, attempts);

  const dossierAfterCreate = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert.equal(dossierAfterCreate.assets.length, 0, "A newly created dossier should not invent reference assets");
  await uploadUiDossierHeadshot(page, character);
  const dossierAfterUiUpload = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert(dossierAfterUiUpload.assets.some((asset) => asset.label === "headshot"), "UI upload must persist a labeled headshot");
  assert.equal(
    dossierAfterUiUpload.wardrobes.find((wardrobe) => wardrobe.name === "Browser Indigo Jacket")?.description,
    "Indigo jacket and copper scarf.",
    "UI wardrobe edits must persist through the real dossier API",
  );
  const charactersAfterUiUpload = (await api(owner, "/characters")).body;
  const uiCharacterAfterCreate = charactersAfterUiUpload
    ?.find?.((candidate) => candidate.id === character.id)
    ?? charactersAfterUiUpload?.characters?.find((candidate) => candidate.id === character.id);
  assert(
    uiCharacterAfterCreate?.hasVoiceSample && uiCharacterAfterCreate.voiceConsentAt,
    "UI voice upload and consent must survive the character save",
  );
  const uiHeadshot = dossierAfterUiUpload.assets.find((asset) => asset.label === "headshot");
  await assertImageLoaded(page, mediaUrl(uiHeadshot), "UI uploaded headshot");
  const approvedDossier = dossierBody(await api(owner, `/characters/${character.id}/dossier`));
  assert.equal(approvedDossier.status, "APPROVED", "UI approval must persist through the real API");
  assert(approvedDossier.assets.some((asset) => asset.label === "headshot"));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Characters|Cast Library/i }).first().waitFor({ timeout: 15_000 });
  await openCharacterEditor(page, character.name);
  const reloadedRole = await optionalVisibleLabel(page, [/^Role$/i, /role in production/i, /character role/i]);
  if (reloadedRole) assert.equal(await reloadedRole.inputValue(), "Browser-created lead");
  const reloadedPerformance = await optionalVisibleLabel(page, [/performance notes/i, /^Performance$/i]);
  if (reloadedPerformance) assert.equal(await reloadedPerformance.inputValue(), "Keep a calm, deliberate delivery.");
  const reloadedWardrobeTab = await optionalVisibleTab(page, [/^Wardrobe$/i, /^Wardrobe Library$/i]);
  assert(reloadedWardrobeTab, "Reloaded character dossier did not retain the wardrobe tab");
  await reloadedWardrobeTab.click();
  const reloadedWardrobeName = page.getByPlaceholder(/Heist Suit|outfit/i).last();
  await reloadedWardrobeName.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await reloadedWardrobeName.inputValue(), "Browser Indigo Jacket");
  const reloadedEditor = page.getByRole("dialog").last();
  await clickDossierTab(reloadedEditor, /Voice Cloning/i, "reloaded voice");
  await page.getByText("Voice Sample Requirements", { exact: true }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  assert(
    (await page.getByText(/voice ready|voice consent|permission confirmed/i).count()) > 0,
    "Reloaded character editor must retain voice consent/readiness",
  );

  await page.screenshot({ path: "/tmp/character-dossier-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/character-dossier-mobile.png", fullPage: true });
  await assertResponsiveLayout(page, "Mobile Characters dossier UI");
  assert.deepEqual(pageErrors, [], "Characters dossier UI must not emit page errors");
  assert.deepEqual(
    attempts,
    [],
    "Characters dossier UI must not submit paid or GPU generation requests",
  );
  assert.equal(
    await generationRowCounts(owner),
    beforeJobs,
    "Characters dossier UI must leave video and Image Studio generation job counts unchanged",
  );
}

async function runResponsiveUi(owner) {
  const page = owner.browserPage;
  const attempts = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  installGenerationGuard(page, attempts);
  const beforeJobs = await generationRowCounts(owner);

  await page.setViewportSize({ width: 1440, height: 1000 });
  const character = await createCharacterFromUi(page, attempts);
  const dialog = page.getByRole("dialog").last();
  const cancel = await optionalVisibleButton(dialog, [/^Cancel$/i, /^Close$/i]);
  assert(cancel, "Responsive Characters fixture dialog did not expose a close control");
  await cancel.click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);

  await page.screenshot({
    path: "/tmp/character-dossier-responsive-library-desktop.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    true,
    "Desktop Characters library must not overflow horizontally",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "/tmp/character-dossier-responsive-library-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    true,
    "Mobile Characters library must not overflow horizontally",
  );

  const editor = await openCharacterEditor(page, character.name);
  const tabs = [
    { key: "references", pattern: /Visual References/i },
    { key: "wardrobe", pattern: /Wardrobe/i },
    { key: "voice", pattern: /Voice Cloning/i },
  ];
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(150);
    for (const tab of tabs) {
      await clickDossierTab(editor, tab.pattern, tab.key);
      await page.waitForTimeout(100);
      if (tab.key === "voice") {
        await editor.getByText("Voice Sample Requirements", { exact: true }).waitFor({
          state: "visible",
          timeout: 5_000,
        });
      }
      await assertResponsiveLayout(page, `${viewport.name} ${tab.key} dossier`);
      await page.screenshot({
        path: `/tmp/character-dossier-responsive-${tab.key}-${viewport.name}.png`,
        fullPage: true,
      });
    }
  }

  assert.deepEqual(pageErrors, [], "Responsive Characters dossier UI must not emit page errors");
  assert.deepEqual(attempts, [], "Responsive Characters dossier UI must not submit generation requests");
  assert.equal(
    await generationRowCounts(owner),
    beforeJobs,
    "Responsive Characters dossier UI must leave generation job counts unchanged",
  );
}

async function removeFixtureCharacter(account, characterId) {
  if (!characterId || !account.browserContext) return;
  await api(account, `/characters/${characterId}`, { method: "DELETE" }).catch(() => undefined);
}

async function cleanupAccount(account) {
  try {
    for (const characterId of characterIds) await removeFixtureCharacter(account, characterId);
    if (account.browserContext) {
      const assetsResponse = await api(account, "/image-studio/assets");
      for (const asset of assetsResponse.body?.assets ?? []) {
        await api(account, `/image-studio/assets/${asset.id}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
    // API cleanup is the normal path. These rows are isolated by the
    // per-run tenant and ensure a failed browser assertion cannot strand
    // fixture media or prevent a later run from using the same database.
    const characterAssets = await pool.query(
      `SELECT ca.storage_key
       FROM obtv_character_assets ca
       JOIN obtv_characters c ON c.id=ca.character_id
       WHERE c.tenant_id=$1`,
      [account.tenantId],
    );
    for (const row of characterAssets.rows) {
      await rm(path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media", row.storage_key), { force: true })
        .catch(() => undefined);
    }
    const imageAssets = await pool.query(
      "SELECT storage_key FROM obtv_image_studio_assets WHERE tenant_id=$1",
      [account.tenantId],
    );
    for (const row of imageAssets.rows) {
      await rm(path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media", row.storage_key), { force: true })
        .catch(() => undefined);
    }
    await pool.query(
      "UPDATE obtv_generation_jobs SET voice_character_id=NULL WHERE tenant_id=$1 AND voice_character_id IS NOT NULL",
      [account.tenantId],
    ).catch(() => undefined);
    await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]);
    await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]);
    await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1", [account.tenantId]);
    await pool.query("DELETE FROM obtv_characters WHERE tenant_id=$1", [account.tenantId]);
    await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]);
    await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id=$1", [account.userId]);
    await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]);
    await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [account.userId]);
    await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]);
  } catch (error) {
    console.error(
      `Character dossier fixture cleanup failed (${account.label}, run ${runId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

try {
  await waitForPreviewReady();
  const owner = await createTenant(await createAccount("Owner"));
  const foreign = await createTenant(await createAccount("Foreign"));

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox"],
  });
  await loginThroughPreview(owner);
  await loginThroughPreview(foreign);
  if (process.env.CHARACTER_DOSSIER_RESPONSIVE_ONLY === "1") {
    await runResponsiveUi(owner);
    console.log(
      "PASS: authenticated responsive Characters library and dossier tab verification with isolated fixtures and no-generation guard",
    );
  } else {
    await assertUnrelatedOriginRejected();
    await runApiContract(owner, foreign);
  try {
    await runBrowserUi(owner);
  } catch (error) {
    const page = owner.browserPage;
    console.error(
      "Character dossier UI selector feedback:",
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        url: page?.url(),
        bodyText: (await page?.locator("body").innerText().catch(() => "")).slice(0, 12_000),
      }, null, 2),
    );
    await page?.screenshot({ path: "/tmp/character-dossier-ui-failure.png", fullPage: true }).catch(() => undefined);
    throw error;
  }
  console.log(
    "PASS: authenticated HTTPS dossier CRUD/reload, tenant isolation, labeled real-image media, primary selection, approval revisions/invalidation, reference deletion, voice consent, responsive UI, and no-generation guard",
  );
  }
} finally {
  for (const account of fixtures) await cleanupAccount(account);
  for (const account of fixtures) {
    await account.browserContext?.close().catch(() => undefined);
  }
  await browser?.close();
  await pool.end();
}