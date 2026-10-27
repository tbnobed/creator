import assert from "node:assert/strict";
import { test } from "node:test";
import { h3DialogueTurns } from "./h3-dialogue";
import { compileMiniMaxH3PromptForTest, type GenerationRequest } from "./generation-service";
import { productionExposureForShot, productionExposureLock } from "./production-exposure";

const cast = [
  { id: "nora", name: "Nora Finch", promptDescription: "An older baker." },
  { id: "eli", name: "Eli", promptDescription: "A young courier." },
];
const input: GenerationRequest = {
  tenantId: "tenant", createdByUserId: "creator", characterIds: ["nora", "eli"],
  longFormShotId: "shot", prompt: "Two people sit at the bakery table.",
  dialogue: "NORA: You're late.\nELI: I know.\nNORA: My name is Nora.",
  generationMode: "H3", durationSeconds: 10, fps: 24, width: 1280, height: 736,
  qualityPreset: "STANDARD", seedMode: "FIXED", seed: 42,
};

test("compiled H3 production prompts carry positive-only exposure instructions", () => {
  const prompt = compileMiniMaxH3PromptForTest(cast, undefined, {
    ...input, continuityContext: productionExposureLock,
  });
  assert.match(prompt, /Maintain the opening frame's illumination/);
  assert.match(prompt, /including the final frame/);
  assert.doesNotMatch(prompt, /fade to black|progressively darker|vignette buildup|gradual dimming|decrease in exposure/i);
  assert.equal(prompt.split("My name is Nora.").length - 1, 1);
});

test("positive-only lighting defaults preserve explicitly authored shot actions", () => {
  const prompt = compileMiniMaxH3PromptForTest(cast, undefined, {
    ...input, prompt: "Nora closes the bakery. Fade to black.",
    continuityContext: productionExposureForShot("Nora closes the bakery. Fade to black."),
  });
  assert.match(prompt, /Nora closes the bakery\. Fade to black\./);
  assert.doesNotMatch(prompt, /Maintain the opening frame's illumination/);
});

test("speaker labels become separate metadata while literal name mentions remain speech", () => {
  assert.deepEqual(h3DialogueTurns(input.dialogue!, cast.map(c => c.name)), [
    { speakerIndex: 0, text: "You're late." },
    { speakerIndex: 1, text: "I know." },
    { speakerIndex: 0, text: "My name is Nora." },
  ]);
});

test("H3 labeled dialogue occurs once, in order, bound to distinct subject/voice IDs", () => {
  const prompt = compileMiniMaxH3PromptForTest(cast, undefined, input);
  assert.deepEqual([...prompt.matchAll(/<d>\[English\] (.*?)<\/d>/g)].map(m => m[1]), [
    "You're late.", "I know.", "My name is Nora.",
  ]);
  assert.equal(prompt.split("You're late.").length - 1, 1);
  assert.equal(prompt.split("I know.").length - 1, 1);
  assert.match(prompt, /<Subject 1> \(S1\) says clearly/);
  assert.match(prompt, /<Subject 2> \(S2\) says clearly/);
  assert.match(prompt, /<Subject 1> is Nora Finch/);
  assert.match(prompt, /<Subject 2> is Eli/);
  assert.doesNotMatch(prompt, /<d>[^<]*(?:NORA:|ELI:)/);
  assert.ok(prompt.indexOf("<d>") < prompt.indexOf("subject_definitions:"));
});

test("wrapped lines and parenthetical speaker directions do not leak names into speech", () => {
  assert.deepEqual(h3DialogueTurns("Nora Finch (quietly): Three rolls\nand some advice.\nELI: I'll take it.", cast.map(c => c.name)), [
    { speakerIndex: 0, text: "Three rolls and some advice." },
    { speakerIndex: 1, text: "I'll take it." },
  ]);
});

test("unknown or ambiguous speakers fail rather than being read aloud or assigned arbitrarily", () => {
  assert.throws(() => h3DialogueTurns("OWEN: Hello.", ["Nora", "Eli"]), /does not match/);
  assert.throws(() => h3DialogueTurns("ELI: Hello.", ["Eli Stone", "Eli Brown"]), /does not match/);
});

test("unlabeled standard dialogue keeps the established speech grammar", () => {
  assert.equal(h3DialogueTurns("The time is 4:30.", ["Eli"]), null);
  const prompt = compileMiniMaxH3PromptForTest(cast, undefined, {
    ...input, dialogue: "The signal is alive.", speakerCharacterId: "eli",
  });
  assert.match(prompt, /<Subject 2> \(S1\) says clearly at a natural speaking rate: <d>\[English\] The signal is alive.<\/d>/);
});

test("legacy inline turns are separated and narrator labels remain non-spoken metadata", () => {
  assert.deepEqual(h3DialogueTurns("NORA: You're late. ELI: I know.", cast.map(c => c.name)), [
    { speakerIndex: 0, text: "You're late." }, { speakerIndex: 1, text: "I know." },
  ]);
  const prompt = compileMiniMaxH3PromptForTest(cast, undefined, {
    ...input, dialogue: "NARRATOR: The bakery closes tonight.",
  });
  assert.match(prompt, /off-screen narrator \(S0\).*<d>\[English\] The bakery closes tonight.<\/d>/);
  assert.doesNotMatch(prompt, /<d>[^<]*NARRATOR:/);
});
