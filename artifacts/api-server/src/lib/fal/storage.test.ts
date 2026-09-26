import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadFalStorageFile } from "./storage";

test("Fal storage uses restricted upload and returns only a signed read URL", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const result = await uploadFalStorageFile(
    bytes,
    "video/mp4",
    "reference.mp4",
    "test-secret",
    async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://rest.fal.ai/")) {
        if (url.includes("/storage/upload/initiate")) {
          return Response.json({
            upload_url: "https://v3b.fal.media/files/b/test/reference.mp4?token=temporary",
            file_url: "https://v3b.fal.media/files/b/test/reference.mp4",
          });
        }
        return Response.json({ token: "short-lived-cdn-token" });
      }
      if (url.endsWith("/sign")) {
        return new Response("https://v3b.fal.media/files/b/test/reference.mp4?signature=readonly");
      }
      return new Response(null, { status: 200 });
    },
  );

  assert.equal(result, "https://v3b.fal.media/files/b/test/reference.mp4?signature=readonly");
  assert.equal(calls.length, 4);
  assert.equal(calls[0]?.url, "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3");
  const initHeaders = new Headers(calls[0]?.init?.headers);
  assert.equal(initHeaders.get("authorization"), "Key test-secret");
  assert.deepEqual(JSON.parse(initHeaders.get("x-fal-object-lifecycle-preference") ?? "{}"), {
    initial_acl: { default: "forbid" },
  });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    file_name: "reference.mp4",
    content_type: "video/mp4",
  });
  assert.equal(calls[1]?.init?.method, "PUT");
  assert.equal(new Headers(calls[1]?.init?.headers).get("authorization"), null);
  assert.deepEqual([...new Uint8Array(calls[1]?.init?.body as Uint8Array)], [...bytes]);
  assert.equal(calls[2]?.url, "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3");
  assert.equal(new Headers(calls[2]?.init?.headers).get("authorization"), "Key test-secret");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { expiration_seconds: 300 });
  assert.equal(calls[3]?.url, "https://v3b.fal.media/files/b/test/reference.mp4/sign");
  assert.equal(new Headers(calls[3]?.init?.headers).get("authorization"), "Bearer short-lived-cdn-token");
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { duration: 604800, scope: ["read"] });
});

test("Fal storage rejects untrusted receipt URLs without uploading data", async () => {
  let putCount = 0;
  await assert.rejects(
    uploadFalStorageFile(new Uint8Array([1]), "audio/mpeg", "audio.mp3", "test-secret", async (input) => {
      if (String(input).startsWith("https://rest.fal.ai/")) {
        return Response.json({
          upload_url: "https://storage.googleapis.com/fal-test/signed",
          file_url: "https://attacker.example/private.mp3",
        });
      }
      putCount += 1;
      return new Response(null, { status: 200 });
    }),
    /untrusted reference media URL/,
  );
  assert.equal(putCount, 0);
});

test("Fal storage rejects upload URLs outside the documented trusted hosts", async () => {
  let putCount = 0;
  for (const uploadUrl of [
    "https://v3b.fal.media.attacker.example/files/b/test/audio.mp3?token=temporary",
    "https://user@v3b.fal.media/files/b/test/audio.mp3?token=temporary",
    "https://v3b.fal.media/not/a/fal/path?token=temporary",
    "http://v3b.fal.media/files/b/test/audio.mp3?token=temporary",
  ]) {
    await assert.rejects(
      uploadFalStorageFile(new Uint8Array([1]), "audio/mpeg", "audio.mp3", "test-secret", async (input) => {
        if (String(input).includes("/storage/upload/initiate")) {
          return Response.json({
            upload_url: uploadUrl,
            file_url: "https://v3b.fal.media/files/b/test/audio.mp3",
          });
        }
        putCount += 1;
        return new Response(null, { status: 200 });
      }),
      /untrusted upload URL/,
    );
  }
  assert.equal(putCount, 0);
});

test("Fal storage fails closed when restricted-media signing fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    uploadFalStorageFile(new Uint8Array([1]), "audio/mpeg", "audio.mp3", "test-secret", async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/storage/upload/initiate")) {
        return Response.json({
          upload_url: "https://storage.googleapis.com/fal-test/signed",
          file_url: "https://v3b.fal.media/files/b/test/audio.mp3",
        });
      }
      if (url.startsWith("https://storage.googleapis.com/")) return new Response(null, { status: 200 });
      if (url.includes("/storage/auth/token")) return Response.json({ token: "temporary-token" });
      return new Response(null, { status: 403 });
    }),
    /could not be signed \(403\)/,
  );
  assert.equal(calls.length, 4);
  assert.ok(calls[3]?.endsWith("/sign"));
});