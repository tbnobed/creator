import test from "node:test";
import assert from "node:assert/strict";
import { planAuthoredDialogue } from "./production-dialogue-plan";
import { parseAuthoredScenes } from "./production-script-plan";

const spoken = (s: string) => s.replace(/^[A-Z][A-Z .'-]*:\s*/gm, "").match(/[\p{L}\p{N}]+/gu) ?? [];
test("wrapped bakery dialogue remains dialogue rather than action", () => {
  const [scene] = parseAuthoredScenes("SCENE 3 — BAKERY FRONT ROOM — EVENING — 2:00–3:00\nNORA: Wake up at four. Remember I don't have to.\nGo back to sleep.\n\nEli smiles.")!;
  assert.match(scene.dialogue, /Go back to sleep/);
  assert.doesNotMatch(scene.action, /Go back to sleep/);
  assert.match(scene.action, /Eli smiles/);
});
test("authored words, speakers and timing survive allocation without an AI copy", () => {
  const dialogue = `NORA: ${"Don't change my words. ".repeat(18)}\nELI: I won't.`;
  const shots = planAuthoredDialogue(dialogue, 55, 5);
  assert.deepEqual(spoken(shots.map(s => s.dialogue).join("\n")), spoken(dialogue));
  assert.equal(shots.reduce((n,s) => n+s.durationSeconds, 0), 55);
  assert.ok(shots.some(s => s.durationSeconds > 5));
  assert.ok(shots.every(s => s.durationSeconds <= 30 && Math.ceil(spoken(s.dialogue).length / 2.1 + 2) <= s.durationSeconds));
  assert.match(shots.at(-1)!.dialogue, /ELI:/);
});
test("silent shots and fractional duration remain valid; impossible timing fails explicitly", () => {
  const shots = planAuthoredDialogue("", 10.5, 5);
  assert.equal(shots.reduce((n,s) => n+s.durationSeconds, 0), 10.5);
  assert.ok(shots.every(s => !s.dialogue));
  assert.throws(() => planAuthoredDialogue("NORA: " + "word ".repeat(50), 5, 5), /Increase its time range/);
});
