import test from "node:test";
import assert from "node:assert/strict";
import { applyNativeComposition, hasCompositionSchemas, validateNativeComposition, type NativeComposition } from "./image-native-composition";
import { openingIdentity, openingSubjectAction } from "./production-opening-prompts";
import { openingInputs } from "./production-openings";
import { emptyProduction } from "./production-types";

const plan = (): NativeComposition => ({
  version: 2, backgroundPrompt: "Wetland scenery", backgroundReferenceIndexes: [0],
  subjects: [
    { name: "Cleo", referenceIndex: 1, prompt: "One crab Cleo", x: 16, y: 16, width: 240, height: 400 },
    { name: "Barns", referenceIndex: 2, prompt: "One shark Barns", x: 272, y: 16, width: 240, height: 400 },
    { name: "Ridley", referenceIndex: 3, prompt: "One bird Ridley", x: 528, y: 16, width: 240, height: 400 },
  ],
});

test("separate cropped samplers give each subject scenery plus only its own identity encoding", () => {
  const graph = {
    "4": { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["2", 0] } as Record<string, unknown> },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } as Record<string, unknown> },
    "11": { class_type: "ReferenceLatent", inputs: {} },
    "12": { class_type: "ReferenceLatent", inputs: {} },
    "13": { class_type: "CFGGuider", inputs: {} as Record<string, unknown> },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
    "15": { class_type: "ImageScale", inputs: { image: ["14", 0], width: 1024, height: 0, crop: "disabled", upscale_method: "nearest-exact" } },
    "18": { class_type: "SaveImage", inputs: { images: ["17", 0] } },
  } as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const p = plan();
  applyNativeComposition(graph, p, ["location", "crab", "shark", "bird"], 800, 448);
  const walkReferences = (nodeId: string): string[] => {
    const node = graph[nodeId];
    if (!node) return [];
    const parent = node.inputs.conditioning as [string, number] | undefined;
    return [...(parent ? walkReferences(parent[0]) : []),
      ...(node.class_type === "ReferenceLatent" ? [(node.inputs.latent as string[])[0]] : [])];
  };
  for (const subject of p.subjects) {
    const [textId] = Object.entries(graph).find(([, node]) => node.class_type === "CLIPTextEncode" && node.inputs.text === subject.prompt)!;
    const chains = Object.values(graph).filter(node => node.class_type === "CFGGuider")
      .map(node => walkReferences((node.inputs.positive as string[])[0]));
    assert.ok(textId);
    const own = chains.find(chain => chain[1] === ["", "crab", "shark", "bird"][subject.referenceIndex])!;
    assert.equal(own.length, 2);
    assert.equal(graph[own[0]].class_type, "VAEEncode");
    assert.equal(chains.filter(chain => chain.includes(["", "crab", "shark", "bird"][subject.referenceIndex])).length, 1);
  }
  assert.equal(graph["13"], undefined);
  assert.equal(Object.values(graph).filter(node => node.class_type === "SamplerCustomAdvanced").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "ImageCrop").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "ImageCompositeMasked").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "FeatherMask").length, 3);
  const last = graph[(graph["18"].inputs.images as string[])[0]];
  assert.equal(last.class_type, "ImageCompositeMasked");
});

test("invalid, overlapping, or dropped-reference regional plans fail closed", () => {
  const p = plan();
  assert.doesNotThrow(() => validateNativeComposition(p, 800, 448, 4));
  assert.throws(() => validateNativeComposition(p, 800, 448, 5), /every reference/);
  p.subjects[1].referenceIndex = 1;
  assert.throws(() => validateNativeComposition(p, 800, 448, 4), /every reference/);
  p.subjects[1].referenceIndex = 2;
  p.subjects[1].x = 20;
  assert.throws(() => validateNativeComposition(p, 800, 448, 4), /not overlap/);
  p.subjects[1].x = 272; p.subjects[0].width = 900;
  assert.throws(() => validateNativeComposition(p, 800, 448, 4), /bounds/);
  assert.equal(hasCompositionSchemas({}), false);
});

test("a recurring prop gets a background-only pass, separate from the character samplers", () => {
  const p = plan();
  p.subjects = p.subjects.slice(0, 2);
  p.backgroundReferenceIndexes = [0, 3];
  const graph = {
    "9": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
    "15": { class_type: "ImageScale", inputs: { image: ["14", 0], width: 1024, height: 0, crop: "disabled", upscale_method: "nearest-exact" } },
    "18": { class_type: "SaveImage", inputs: { images: ["17", 0] } },
  } as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  applyNativeComposition(graph, p, ["location", "crab", "shark", "prop"], 800, 448);
  assert.equal(Object.values(graph).filter(node => node.class_type === "SamplerCustomAdvanced").length, 3);
  const firstGuider = Object.values(graph).find(node => node.class_type === "CFGGuider")!;
  const positive = graph[(firstGuider.inputs.positive as string[])[0]];
  assert.deepEqual(positive.inputs.latent, ["prop", 0]);
  const previous = graph[(positive.inputs.conditioning as string[])[0]];
  assert.deepEqual(previous.inputs.latent, ["location", 0]);
});

test("identity notes retain anatomy and accessories without studio/model-sheet instructions", () => {
  const identity = openingIdentity("Full-body character concept turnaround, 3D animated feature quality, Pixar and Disney animation style, 8k resolution, clean soft-grey studio background. Barns, an anthropomorphic leopard shark with spots. Orange-and-teal wrist guards, detailed skin texture, symmetrical centered character model sheet framing, Octane render.");
  assert.match(identity, /leopard shark with spots/);
  assert.match(identity, /Orange-and-teal wrist guards/);
  assert.doesNotMatch(identity, /studio|turnaround|8k|model sheet|Octane|Pixar|concept/i);
});

test("shared actions become individual actions without describing another character", () => {
  const action = "Golden hour: Ridley, Cleo, and Barns gaze over the sea. Barns rests with his head and fins in a tidal pool, Cleo perched nearby.";
  const names = ["Cleo", "Barns", "Ridley"];
  const barns = openingSubjectAction(action, "Barns", names);
  assert.match(barns, /Barns gaze over the sea/);
  assert.match(barns, /Barns rests with his head and fins in a tidal pool/);
  assert.doesNotMatch(barns, /Cleo|Ridley/);
});

test("multi-character openings produce bounded regional plans; approved wardrobe and all refs are preserved", () => {
  const s = emptyProduction();
  s.characters = ["Cleo", "Barns", "Ridley"].map(name => ({ id: name, name, description: `3D animated character. ${name} identity.`,
    selectedAssetId: `${name}-portrait`, locked: true, status: "LOCKED", seed: 1, options: [], referenceSheet: [] }));
  s.wardrobes = [{ id: "outfit", characterId: "Cleo", name: "Cap", prompt: "Purple cap",
    fromScene: 1, toScene: 1, status: "READY", assetId: "dressed-crab", approvedAssetId: "dressed-crab" }];
  s.places = [{ id: "bay", name: "Bay", prompt: "Bay", seed: 1, variants: [], status: "READY", assetId: "bay-image" }];
  const scene = { sceneNumber: 1, title: "Bay", location: "Bay", timeOfDay: "Dawn",
    characters: ["Cleo", "Barns", "Ridley"], action: "Cleo, Barns and Ridley gaze at the sea.", dialogue: "" };
  const inputs = openingInputs(s, scene);
  assert.match(inputs.prompt, /^One 3D animated film frame/);
  assert.deepEqual(inputs.ids, ["bay-image", "dressed-crab", "Barns-portrait", "Ridley-portrait"]);
  assert.ok(inputs.composition);
  assert.doesNotThrow(() => validateNativeComposition(inputs.composition!, 1280, 720, 4));
  assert.doesNotMatch(inputs.composition.subjects[0].prompt, /Barns|Ridley/);
  assert.match(inputs.composition.subjects[0].prompt, /Purple cap/);
});
