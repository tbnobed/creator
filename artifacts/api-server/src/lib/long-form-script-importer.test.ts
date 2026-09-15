import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planLongFormShotsForTest } from "./long-form-service";

const originalScript = readFileSync(
  new URL("../../../../attached_assets/symposium-intro-video-script_1789486065822.md", import.meta.url),
  "utf8",
);

const projectInput = (script: string, overrides: Record<string, unknown> = {}) => ({
  title: "Importer test",
  script,
  targetDurationSeconds: 190,
  shotDurationSeconds: 8,
  generationMode: "H3",
  width: 1920,
  height: 1080,
  fps: 24,
  qualityPreset: "STANDARD",
  ...overrides,
});

test("original symposium script stays 30 authored shots with exact durations and clean prompts", () => {
  const shots = planLongFormShotsForTest(projectInput(originalScript));
  const durations = [6, 6, 8, 6, 6, 7, 6, 6, 6, 6, 7, 6, 7, 7, 6, 6, 7, 7, 6, 7, 6, 6, 7, 6, 5, 6, 6, 6, 6, 7];

  assert.equal(shots.length, 30);
  assert.deepEqual(shots.map((shot) => shot.durationSeconds), durations);
  assert.equal(durations.reduce((sum, duration) => sum + duration, 0), 190);
  assert.match(shots[0].prompt, /^Cinematic broadcast facility, ultra-realistic/);
  assert.match(shots[0].prompt, /single coaxial fibre connector/);
  assert.match(shots[29].prompt, /same fibre connector from the first shot/);
  assert.ok(shots.every((shot) => !shot.prompt.includes("[prefix]")));
  assert.ok(shots.every((shot) => !/\b(?:VO|Music|Text \(post\))\s*:/.test(shot.prompt)));
  assert.ok(shots.every((shot) => shot.cameraInstructions === ""));
  assert.ok(shots.every((shot) => shot.motionInstructions === ""));
  assert.ok(shots.every((shot) => shot.continuityNote === ""));
  assert.ok(shots.every((shot) => !shot.prompt.includes("PROJECT VISUAL DIRECTION")));
  assert.ok(shots.every((shot) => shot.dialogue === ""));
});

test("prompt-only authored blocks resolve prefix from storyline and reject unresolved tokens", () => {
  const script = "SHOT 1: Establish the empty rack.\nPrompt: [prefix] A dark rack with one green LED.";
  const withStoryline = planLongFormShotsForTest(projectInput(script, {
    targetDurationSeconds: 5,
    storyline: "Cinematic broadcast facility with restrained teal lighting.",
  }));
  assert.match(withStoryline[0].prompt, /^Cinematic broadcast facility with restrained teal lighting\./);
  assert.doesNotMatch(withStoryline[0].prompt, /\[prefix\]|PROJECT VISUAL DIRECTION/);

  assert.throws(
    () => planLongFormShotsForTest(projectInput(script, { targetDurationSeconds: 5 })),
    /unresolved \[prefix\]/i,
  );
});

test("malformed or bodyless authored headings fail instead of falling back to prose", () => {
  assert.throws(
    () => planLongFormShotsForTest(projectInput("### Shot 1 · 0:00\n**Prompt:** A rack.")),
    /malformed SHOT\/B-ROLL heading/i,
  );
  assert.throws(
    () => planLongFormShotsForTest(projectInput("SHOT 1:\n")),
    /missing a body/i,
  );
  assert.throws(
    () => planLongFormShotsForTest(projectInput("### Shot 1 · 0:00 · 5s\n**VO:** \"Only narration.\"")),
    /missing a visual prompt/i,
  );
});

test("legacy normalized quoted dialogue remains available while post VO stays out of H3", () => {
  const legacy = planLongFormShotsForTest(projectInput(
    "SHOT 1: Presenter at a desk says \"Hello from the control room.\"\nBROLL 2 - A quiet rack of servers.",
    { targetDurationSeconds: 10 },
  ));
  assert.equal(legacy.length, 2);
  assert.equal(legacy[0].dialogue, "Hello from the control room.");
  assert.equal(legacy[1].dialogue, "");
  assert.doesNotMatch(legacy[0].prompt, /Hello from the control room/);

  const post = planLongFormShotsForTest(projectInput(
    "SHOT 1: Establish the room.\nPrompt: A dark control room with glowing monitors.\nVO: \"Recorded separately.\"",
    { targetDurationSeconds: 5 },
  ));
  assert.equal(post[0].dialogue, "");
  assert.doesNotMatch(post[0].prompt, /Recorded separately/);
});

test("authored duration totals must match the project target", () => {
  assert.throws(
    () => planLongFormShotsForTest(projectInput(
      "### Shot 1 · 0:00 · 5s\n**Prompt:** A dark room.",
      { targetDurationSeconds: 6 },
    )),
    /durations total 5 seconds.*target is 6 seconds/i,
  );
});