import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
test("service worker leaves API, video, range and static requests to the network", () => {
  const handlers = {};
  const context = vm.createContext({
    self: { location: { origin: "https://studio.test" }, addEventListener: (name, fn) => handlers[name] = fn },
    URL,
    fetch: () => Promise.resolve({ ok: false }),
  });
  vm.runInContext(readFileSync("artifacts/obtv-video-studio/public/sw.js", "utf8"), context);
  for (const [path, mode, range] of [
    ["/api/media/test.mp4", "cors", false], ["/movie.mp4", "no-cors", false],
    ["/api/media/test.mp4", "navigate", false], ["/movie.mp4", "navigate", true],
    ["/movie.mp4", "navigate", false], ["/api", "navigate", false],
    ["/assets/main.js", "cors", false],
  ]) {
    let intercepted = false;
    handlers.fetch({ request: { url: `https://studio.test${path}`, method: "GET", mode,
      headers: { has: () => range } }, respondWith: () => intercepted = true });
    assert.equal(intercepted, false, path);
  }
  let navigation = false;
  handlers.fetch({ request: { url: "https://studio.test/studio", method: "GET", mode: "navigate",
    headers: { has: () => false } }, respondWith: () => navigation = true });
  assert.equal(navigation, true);
});
