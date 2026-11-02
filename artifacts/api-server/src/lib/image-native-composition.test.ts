import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { applyNativeComposition, compositionSegmentationModel, hasCompositionSchemas, validateNativeComposition, validateCompositionMask, type NativeComposition } from "./image-native-composition";
import { openingSubjectAction } from "./production-opening-prompts";
import { openingInputs } from "./production-openings";
import { emptyProduction } from "./production-types";

const plan = (): NativeComposition => ({
  version: 3, backgroundPrompt: "Wetland scenery", backgroundReferenceIndexes: [0],
  subjects: [
    { name: "Subject A", referenceIndex: 1, prompt: "Subject from first portrait", x: 16, y: 16, width: 240, height: 400 },
    { name: "Subject B", referenceIndex: 2, prompt: "Subject from second portrait", x: 272, y: 16, width: 240, height: 400 },
    { name: "Subject C", referenceIndex: 3, prompt: "Subject from third portrait", x: 528, y: 16, width: 240, height: 400 },
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
  applyNativeComposition(graph, p, ["location", "identity-1", "identity-2", "identity-3"], 800, 448);
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
    const own = chains.find(chain => chain[1] === ["", "identity-1", "identity-2", "identity-3"][subject.referenceIndex])!;
    assert.equal(own.length, 2);
    assert.equal(graph[own[0]].class_type, "VAEEncode");
    assert.equal(chains.filter(chain => chain.includes(["", "identity-1", "identity-2", "identity-3"][subject.referenceIndex])).length, 1);
  }
  assert.equal(graph["13"], undefined);
  assert.equal(Object.values(graph).filter(node => node.class_type === "SamplerCustomAdvanced").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "ImageCrop").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "ImageCompositeMasked").length, 3);
  assert.equal(Object.values(graph).filter(node => node.class_type === "FeatherMask").length, 3);
  const last = graph[(graph["18"].inputs.images as string[])[0]];
  assert.equal(last.class_type, "ImageCompositeMasked");
  assert.equal(graph[(last.inputs.mask as string[])[0]].class_type, "MaskComposite");
  assert.equal(Object.values(graph).filter(node => node.class_type === "SAM3_Detect").length, 6);
  assert.ok(Object.values(graph).some(node => node.class_type === "CLIPTextEncode" && node.inputs.text === "reflection"));
  assert.equal(Object.values(graph).filter(node => node.class_type === "SaveImage").length, 4);
  const segmentation = Object.values(graph).find(node => node.class_type === "CheckpointLoaderSimple")!;
  assert.equal(segmentation.inputs.ckpt_name, compositionSegmentationModel);
});

test("foreground masks reject empty, full-frame and wrong-size output", () => {
  const subject = { name: "Subject A", width: 64, height: 64 };
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(0);
  assert.throws(() => validateCompositionMask(PNG.sync.write(png), subject), /Could not isolate Subject A/);
  png.data.fill(255);
  assert.throws(() => validateCompositionMask(PNG.sync.write(png), subject), /Could not isolate Subject A/);
  png.data.fill(0);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
    png.data.fill(255, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
  }
  assert.doesNotThrow(() => validateCompositionMask(PNG.sync.write(png), subject));
  assert.throws(() => validateCompositionMask(PNG.sync.write(png), { ...subject, width: 32 }), /Invalid foreground mask/);
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
  applyNativeComposition(graph, p, ["location", "identity-1", "identity-2", "prop"], 800, 448);
  assert.equal(Object.values(graph).filter(node => node.class_type === "SamplerCustomAdvanced").length, 3);
  const firstGuider = Object.values(graph).find(node => node.class_type === "CFGGuider")!;
  const positive = graph[(firstGuider.inputs.positive as string[])[0]];
  assert.deepEqual(positive.inputs.latent, ["prop", 0]);
  const previous = graph[(positive.inputs.conditioning as string[])[0]];
  assert.deepEqual(previous.inputs.latent, ["location", 0]);
});

test("shared actions become individual actions without describing another character", () => {
  const names = ["Subject A", "Subject B", "Subject C"];
  const action = `${names.join(", ")} look toward the horizon. ${names[1]} waits nearby.`;
  const individual = openingSubjectAction(action, names[1], names);
  assert.ok(individual.includes(`${names[1]} look toward the horizon`));
  assert.ok(individual.includes(`${names[1]} waits nearby`));
  assert.ok(!individual.includes(names[0]) && !individual.includes(names[2]));
});

test("multi-character openings produce bounded regional plans; approved wardrobe and all refs are preserved", () => {
  const s = emptyProduction();
  s.characters = ["Subject A", "Subject B", "Subject C"].map(name => ({ id: name, name, description: `Unused creation description for ${name}.`,
    selectedAssetId: `${name}-portrait`, locked: true, status: "LOCKED", seed: 1, options: [], referenceSheet: [] }));
  s.wardrobes = [{ id: "outfit", characterId: "Subject A", name: "Approved outfit", prompt: "Creator supplied wardrobe direction",
    fromScene: 1, toScene: 1, status: "READY", assetId: "outfit-reference", approvedAssetId: "outfit-reference" }];
  s.places = [{ id: "bay", name: "Bay", prompt: "Bay", seed: 1, variants: [], status: "READY", assetId: "bay-image" }];
  const scene = { sceneNumber: 1, title: "Bay", location: "Bay", timeOfDay: "Dawn",
    characters: ["Subject A", "Subject B", "Subject C"], action: "Subject A, Subject B and Subject C gaze at the sea.", dialogue: "" };
  const inputs = openingInputs(s, scene);
  assert.match(inputs.prompt, /^One film frame matching the visual style of the approved reference images/);
  assert.deepEqual(inputs.ids, ["bay-image", "outfit-reference", "Subject B-portrait", "Subject C-portrait"]);
  assert.ok(inputs.composition);
  assert.doesNotThrow(() => validateNativeComposition(inputs.composition!, 1280, 720, 4));
  assert.doesNotMatch(inputs.composition.subjects[0].prompt, /Subject B|Subject C/);
  assert.match(inputs.composition.subjects[0].prompt, /Creator supplied wardrobe direction/);
});
