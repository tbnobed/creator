import assert from "node:assert/strict";
import test from "node:test";
import { browserOrigins } from "./browser-origins";

test("development accepts only exact workspace HTTPS preview origins", () => {
  const origins = browserOrigins({
    NODE_ENV: "development",
    REPLIT_DEV_DOMAIN: "workspace-a.replit.dev",
    REPLIT_DOMAINS: "workspace-a.replit.dev, workspace-b.replit.dev ",
  });
  assert.deepEqual([...origins], ["https://workspace-a.replit.dev", "https://workspace-b.replit.dev"]);
  for (const untrusted of [
    "https://other-workspace.replit.dev",
    "https://workspace-a.replit.dev.attacker.example",
    "http://workspace-a.replit.dev",
    "null",
  ]) assert.equal(origins.has(untrusted), false);
});

for (const environment of ["production", "test", undefined]) {
  test(`${environment ?? "unset"} mode does not trust development hosts`, () => {
    const origins = browserOrigins({
      NODE_ENV: environment,
      APP_ORIGINS: " https://studio.example.com,https://admin.example.com ",
      REPLIT_DEV_DOMAIN: "workspace-a.replit.dev",
      REPLIT_DOMAINS: "workspace-b.replit.dev",
    });
    assert.deepEqual([...origins], ["https://studio.example.com", "https://admin.example.com"]);
  });
}

test("malformed preview metadata and wildcards cannot broaden access", () => {
  const origins = browserOrigins({
    NODE_ENV: "development",
    REPLIT_DEV_DOMAIN: "*.replit.dev",
    REPLIT_DOMAINS: "https://bad.example,host.example/path,user@host.example,host.example#fragment",
  });
  assert.equal(origins.size, 0);
});

test("development retains explicitly configured origins", () => {
  const origins = browserOrigins({
    NODE_ENV: "development",
    APP_ORIGINS: "http://localhost:5173",
    REPLIT_DEV_DOMAIN: "workspace-a.replit.dev",
  });
  assert.equal(origins.has("http://localhost:5173"), true);
  assert.equal(origins.has("https://workspace-a.replit.dev"), true);
});