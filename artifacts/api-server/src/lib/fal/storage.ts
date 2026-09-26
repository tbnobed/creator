import { FalHttpError } from "./client";

const ACL_HEADER = "X-Fal-Object-Lifecycle-Preference";
const SIGNED_READ_DURATION_SECONDS = 7 * 24 * 60 * 60;

function trustedFileUrl(value: unknown): string {
  if (typeof value !== "string") throw new FalHttpError("Cloud returned an invalid reference media URL", null, false);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FalHttpError("Cloud returned an invalid reference media URL", null, false);
  }
  if (
    url.protocol !== "https:"
    || (url.hostname !== "fal.media" && !url.hostname.endsWith(".fal.media"))
    || url.username
    || url.password
  ) {
    throw new FalHttpError("Cloud returned an untrusted reference media URL", null, false);
  }
  return url.toString();
}

function trustedUploadUrl(value: unknown): string {
  if (typeof value !== "string") throw new FalHttpError("Cloud returned an invalid upload URL", null, false);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FalHttpError("Cloud returned an invalid upload URL", null, false);
  }
  const falCdnUpload = url.hostname === "v3b.fal.media";
  const googleStorageUpload = url.hostname === "storage.googleapis.com";
  const pathIsValid = falCdnUpload
    ? /^\/files\/b\/[^/]+\/[^/]+$/.test(url.pathname)
    : googleStorageUpload
      ? /^\/[^/]+\/[^/]+(?:\/.*)?$/.test(url.pathname)
      : false;
  if (
    url.protocol !== "https:"
    || (!falCdnUpload && !googleStorageUpload)
    || !pathIsValid
    || Boolean(url.port)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new FalHttpError("Cloud returned an untrusted upload URL", null, false);
  }
  return url.toString();
}

function falFilePath(fileUrl: string): string {
  const path = new URL(fileUrl).pathname;
  if (!/^\/files\/b\/[^/]+\/[^/]+$/.test(path)) {
    throw new FalHttpError("Cloud returned an unsupported reference media path", null, false);
  }
  return path;
}

function trustedSignedReadUrl(value: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FalHttpError("Cloud returned an invalid signed reference media URL", null, false);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "v3b.fal.media"
    || url.pathname !== expectedPath
    || !url.search
    || url.username
    || url.password
    || url.hash
  ) {
    throw new FalHttpError("Cloud returned an untrusted signed reference media URL", null, false);
  }
  return url.toString();
}

export async function uploadFalStorageFile(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  falKey: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const lifecycle = JSON.stringify({ initial_acl: { default: "forbid" } });
  let initiation: Response;
  try {
    initiation = await fetcher("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
        [ACL_HEADER]: lifecycle,
      },
      body: JSON.stringify({ file_name: filename, content_type: mimeType }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new FalHttpError("Cloud reference media upload could not be initiated", null, true);
  }
  if (!initiation.ok) {
    throw new FalHttpError(`Cloud reference media upload could not be initiated (${initiation.status})`, initiation.status, initiation.status === 429 || initiation.status >= 500);
  }

  let receipt: unknown;
  try {
    receipt = await initiation.json();
  } catch {
    throw new FalHttpError("Cloud returned an invalid reference media upload receipt", initiation.status, false);
  }
  const details = receipt && typeof receipt === "object"
    ? receipt as { upload_url?: unknown; file_url?: unknown }
    : {};
  const uploadUrl = trustedUploadUrl(details.upload_url);
  const fileUrl = trustedFileUrl(details.file_url);
  const filePath = falFilePath(fileUrl);

  let uploaded: Response;
  try {
    uploaded = await fetcher(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: Uint8Array.from(bytes),
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch {
    throw new FalHttpError("Cloud reference media bytes could not be uploaded", null, true);
  }
  if (!uploaded.ok) {
    throw new FalHttpError(`Cloud reference media upload failed (${uploaded.status})`, uploaded.status, uploaded.status === 429 || uploaded.status >= 500);
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher("https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiration_seconds: 300 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FalHttpError("Cloud reference media access token could not be obtained", null, true);
  }
  if (!tokenResponse.ok) {
    throw new FalHttpError(`Cloud reference media access token could not be obtained (${tokenResponse.status})`, tokenResponse.status, tokenResponse.status === 429 || tokenResponse.status >= 500);
  }
  let tokenReceipt: unknown;
  try {
    tokenReceipt = await tokenResponse.json();
  } catch {
    throw new FalHttpError("Cloud returned an invalid reference media access token", tokenResponse.status, false);
  }
  const token = tokenReceipt && typeof tokenReceipt === "object"
    ? (tokenReceipt as { token?: unknown }).token
    : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new FalHttpError("Cloud did not return a reference media access token", tokenResponse.status, false);
  }

  let signedResponse: Response;
  try {
    signedResponse = await fetcher(`https://v3b.fal.media${filePath}/sign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ duration: SIGNED_READ_DURATION_SECONDS, scope: ["read"] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FalHttpError("Cloud reference media read URL could not be signed", null, true);
  }
  if (!signedResponse.ok) {
    throw new FalHttpError(`Cloud reference media read URL could not be signed (${signedResponse.status})`, signedResponse.status, signedResponse.status === 429 || signedResponse.status >= 500);
  }
  let signedUrl: string;
  try {
    signedUrl = await signedResponse.text();
  } catch {
    throw new FalHttpError("Cloud returned an invalid signed reference media URL", signedResponse.status, false);
  }
  return trustedSignedReadUrl(signedUrl.trim(), filePath);
}