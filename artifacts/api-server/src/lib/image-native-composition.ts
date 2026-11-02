import { PNG } from "pngjs";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type NativeComposition = {
  version: 3;
  backgroundPrompt: string;
  backgroundReferenceIndexes: number[];
  subjects: { name: string; referenceIndex: number; prompt: string; x: number; y: number; width: number; height: number }[];
};

export const compositionSegmentationModel = "sam3.1_multiplex_fp16.safetensors";
export const compositionNodeClasses = ["SolidMask", "ImageCrop", "FeatherMask", "ImageCompositeMasked",
  "CheckpointLoaderSimple", "SAM3_Detect", "MaskComposite", "GrowMask", "MaskToImage", "ImageBlur", "ImageToMask"];

export function validateNativeComposition(plan: NativeComposition, width: number, height: number, referenceCount: number) {
  if (plan.version !== 3 || !plan.backgroundPrompt?.trim() || !plan.subjects.length || plan.subjects.length > 3
    || !plan.backgroundReferenceIndexes.includes(0)) throw new Error("Invalid regional composition plan.");
  const references = [...plan.backgroundReferenceIndexes, ...plan.subjects.map(s => s.referenceIndex)];
  if (references.length !== referenceCount || new Set(references).size !== referenceCount
    || references.some(i => !Number.isInteger(i) || i < 0 || i >= referenceCount)) {
    throw new Error("Regional composition must assign every reference exactly once.");
  }
  for (const [index, subject] of plan.subjects.entries()) {
    if (!subject.name.trim() || !subject.prompt.trim()
      || ![subject.x, subject.y, subject.width, subject.height].every(Number.isInteger)
      || subject.x < 0 || subject.y < 0 || subject.width < 64 || subject.height < 64 || subject.width % 16 || subject.height % 16
      || subject.x + subject.width > width || subject.y + subject.height > height) {
      throw new Error("Regional character bounds are invalid.");
    }
    for (const other of plan.subjects.slice(0, index)) {
      if (subject.x < other.x + other.width && other.x < subject.x + subject.width
        && subject.y < other.y + other.height && other.y < subject.y + subject.height) {
        throw new Error("Character composition regions must not overlap.");
      }
    }
  }
}

export function hasCompositionSchemas(info: Record<string, unknown>): boolean {
  const fields: Record<string, Record<string, string>> = {
    SolidMask: { value: "FLOAT", width: "INT", height: "INT" },
    ImageCrop: { image: "IMAGE", width: "INT", height: "INT", x: "INT", y: "INT" },
    FeatherMask: { mask: "MASK", left: "INT", top: "INT", right: "INT", bottom: "INT" },
    ImageCompositeMasked: { destination: "IMAGE", source: "IMAGE", x: "INT", y: "INT", resize_source: "BOOLEAN" },
    SAM3_Detect: { model: "MODEL", image: "IMAGE", threshold: "FLOAT", refine_iterations: "INT", individual_masks: "BOOLEAN" },
    MaskComposite: { destination: "MASK", source: "MASK", x: "INT", y: "INT" },
    GrowMask: { mask: "MASK", expand: "INT", tapered_corners: "BOOLEAN" },
    MaskToImage: { mask: "MASK" },
    ImageBlur: { image: "IMAGE", blur_radius: "INT", sigma: "FLOAT" },
    ImageToMask: { image: "IMAGE" },
  };
  for (const [node, expected] of Object.entries(fields)) {
    const required = (info[node] as { input?: { required?: Record<string, unknown[]> } } | undefined)?.input?.required;
    if (!required || Object.entries(expected).some(([key, type]) => required[key]?.[0] !== type)) return false;
  }
  const composite = info.ImageCompositeMasked as { input: { optional?: Record<string, unknown[]> } };
  const detection = info.SAM3_Detect as { input: { optional?: Record<string, unknown[]> } };
  const loader = info.CheckpointLoaderSimple as { input?: { required?: { ckpt_name?: unknown[] } } } | undefined;
  const combo = loader?.input?.required?.ckpt_name;
  const options = Array.isArray(combo?.[0]) ? combo[0]
    : (combo?.[1] as { options?: unknown[] } | undefined)?.options;
  return composite.input.optional?.mask?.[0] === "MASK"
    && detection.input.optional?.conditioning?.[0] === "CONDITIONING"
    && Array.isArray(options) && options.includes(compositionSegmentationModel);
}

/** Reject missing/full-frame masks rather than silently dropping a subject or pasting scenery. */
export function validateCompositionMask(bytes: Buffer, subject: { name: string; width: number; height: number }) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(16) !== subject.width || bytes.readUInt32BE(20) !== subject.height
    || subject.width * subject.height > 2048 * 2048) {
    throw new Error(`Invalid foreground mask for ${subject.name}; no scene image was accepted.`);
  }
  const mask = PNG.sync.read(bytes);
  let pixels = 0;
  for (let offset = 0; offset < mask.data.length; offset += 4) if (mask.data[offset] >= 128) pixels++;
  const coverage = pixels / (subject.width * subject.height);
  if (coverage < .005 || coverage > .8) {
    throw new Error(`Could not isolate ${subject.name} from the scenery; no scene image was accepted. Review the character reference or composition.`);
  }
}

/** Separate samplers and disjoint crops: other identities cannot enter a character's denoising pass. */
export function applyNativeComposition(graph: Graph, plan: NativeComposition, encodings: string[], width: number, height: number) {
  validateNativeComposition(plan, width, height, encodings.length);
  let next = 1000;
  const add = (class_type: string, inputs: Record<string, unknown>) => {
    const id = String(next++); graph[id] = { class_type, inputs }; return id;
  };
  const ref = (id: string) => [id, 0];
  const seed = Number(graph["9"].inputs.noise_seed);
  const resizeTemplate = structuredClone(graph["15"]);
  const segmentation = add("CheckpointLoaderSimple", { ckpt_name: compositionSegmentationModel });
  const segmentationText = add("CLIPTextEncode", { text: "character", clip: [segmentation, 1] });
  const reflectionText = add("CLIPTextEncode", { text: "reflection", clip: [segmentation, 1] });
  const render = (prompt: string, references: string[], targetWidth: number, targetHeight: number, index: number) => {
    const text = add("CLIPTextEncode", { text: prompt, clip: ["2", 0] });
    const zero = add("ConditioningZeroOut", { conditioning: ref(text) });
    const chain = (start: string) => references.reduce((conditioning, latent) =>
      add("ReferenceLatent", { conditioning: ref(conditioning), latent: ref(latent) }), start);
    const guider = add("CFGGuider", { model: ["1", 0], positive: ref(chain(text)), negative: ref(chain(zero)), cfg: 1 });
    const latent = add("EmptyFlux2LatentImage", { width: targetWidth, height: targetHeight, batch_size: 1 });
    const noise = add("RandomNoise", { noise_seed: (seed + index * 104729) % 2147483647 });
    const schedule = add("Flux2Scheduler", { steps: 4, width: targetWidth, height: targetHeight });
    const sampler = add("SamplerCustomAdvanced", { noise: ref(noise), guider: ref(guider),
      sampler: ["8", 0], sigmas: ref(schedule), latent_image: ref(latent) });
    return add("VAEDecode", { samples: ref(sampler), vae: ["3", 0] });
  };
  let composite = add("ImageScale", { image: ["14", 0], upscale_method: "lanczos", width, height, crop: "disabled" });
  if (plan.backgroundReferenceIndexes.length > 1) {
    composite = render(plan.backgroundPrompt, plan.backgroundReferenceIndexes.map(i => encodings[i]), width, height, 0);
  }
  plan.subjects.forEach((subject, index) => {
    const crop = add("ImageCrop", { image: ref(composite), x: subject.x, y: subject.y, width: subject.width, height: subject.height });
    const resized = add(resizeTemplate.class_type, { ...resizeTemplate.inputs, image: ref(crop) });
    const encoded = add("VAEEncode", { pixels: ref(resized), vae: ["3", 0] });
    const image = render(subject.prompt, [encoded, encodings[subject.referenceIndex]], subject.width, subject.height, index + 1);
    const foreground = add("SAM3_Detect", { model: ref(segmentation), image: ref(image),
      conditioning: ref(segmentationText), threshold: .25, refine_iterations: 2, individual_masks: false });
    const reflection = add("SAM3_Detect", { model: ref(segmentation), image: ref(image),
      conditioning: ref(reflectionText), threshold: .25, refine_iterations: 2, individual_masks: false });
    const contact = add("MaskComposite", { destination: ref(foreground), source: ref(reflection), x: 0, y: 0, operation: "add" });
    const grown = add("GrowMask", { mask: ref(contact), expand: 1, tapered_corners: true });
    const matteImage = add("MaskToImage", { mask: ref(grown) });
    const blurred = add("ImageBlur", { image: ref(matteImage), blur_radius: 1, sigma: .8 });
    const matte = add("ImageToMask", { image: ref(blurred), channel: "red" });
    const mask = add("SolidMask", { value: 1, width: subject.width, height: subject.height });
    const feather = Math.min(24, Math.floor(Math.min(subject.width, subject.height) / 8));
    const softMask = add("FeatherMask", { mask: ref(mask), left: feather, top: feather, right: feather, bottom: feather });
    const boundedMatte = add("MaskComposite", { destination: ref(matte), source: ref(softMask), x: 0, y: 0, operation: "multiply" });
    const savedMatte = add("MaskToImage", { mask: ref(boundedMatte) });
    add("SaveImage", { images: ref(savedMatte), filename_prefix: `obtv-composition-mask-${index}` });
    composite = add("ImageCompositeMasked", { destination: ref(composite), source: ref(image),
      x: subject.x, y: subject.y, resize_source: false, mask: ref(boundedMatte) });
  });
  graph["18"].inputs.images = ref(composite);
  // Unused original joint sampler/conditioning must not remain reachable.
  for (const id of ["4", "5", "6", "7", "9", "11", "12", "13", "16", "17"]) delete graph[id];
}
