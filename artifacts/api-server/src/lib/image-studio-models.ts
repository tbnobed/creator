// Stable backend/UI contract: coordinate changes with the Image Studio jobs and routes owner.
export type ImageOperation =
  | "generate"
  | "edit"
  | "inpaint"
  | "outpaint"
  | "upscale"
  | "remove-background";

export interface ImageModel {
  id: string;
  name: string;
  provider: "LOCAL" | "CLOUD";
  description: string;
  operations: ImageOperation[];
  aspectRatios: string[];
  maxImages: number;
  supportsSeed: boolean;
  supportsNegativePrompt: boolean;
  maxReferences: number;
  priceNote: string;
  endpoint?: string;
  requiredTag?: string;
}

const standardRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const googleRatios = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9",
];

/**
 * Price notes mirror the public model pages checked with the endpoint schemas.
 * Cloud prices can change; the account's live estimate remains authoritative.
 */
export const imageModels: ImageModel[] = [
  {
    id: "local-flux2-klein-4b",
    name: "FLUX.2 klein 4B",
    provider: "LOCAL",
    description: "Fast Apache-2.0 text and latent-variation image generation on an installed ComfyUI worker.",
    operations: ["generate", "edit"],
    aspectRatios: standardRatios,
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxReferences: 1,
    priceNote: "Local GPU — no per-image Cloud charge.",
    requiredTag: "flux2-klein",
  },
  {
    id: "local-qwen-image-2512",
    name: "Qwen-Image-2512",
    provider: "LOCAL",
    description: "High-detail text and latent-variation image generation on a compatible ComfyUI worker.",
    operations: ["generate", "edit"],
    aspectRatios: standardRatios,
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: true,
    maxReferences: 1,
    priceNote: "Local GPU — no per-image Cloud charge.",
    requiredTag: "qwen-image-2512",
  },
  {
    id: "local-z-image-turbo",
    name: "Z-Image Turbo",
    provider: "LOCAL",
    description: "Efficient Apache-2.0 text and latent-variation generation with an 8-step ComfyUI workflow.",
    operations: ["generate", "edit"],
    aspectRatios: standardRatios,
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxReferences: 1,
    priceNote: "Local GPU — no per-image Cloud charge.",
    requiredTag: "z-image-turbo",
  },
  {
    id: "cloud-nano-banana-2",
    name: "Nano Banana 2",
    provider: "CLOUD",
    description: "Fast image generation and multi-reference natural-language editing.",
    operations: ["generate", "edit"],
    aspectRatios: [...googleRatios, "4:1", "1:4", "8:1", "1:8"],
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxReferences: 14,
    priceNote: "Est. $0.08/image at 1K; $0.06 at 0.5K, $0.12 at 2K, $0.16 at 4K.",
    endpoint: "fal-ai/nano-banana-2",
  },
  {
    id: "cloud-nano-banana-pro",
    name: "Nano Banana Pro",
    provider: "CLOUD",
    description: "High-fidelity image generation and multi-reference editing up to 4K.",
    operations: ["generate", "edit"],
    aspectRatios: googleRatios,
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxReferences: 14,
    priceNote: "Est. $0.15/image at 1K or 2K; $0.30/image at 4K.",
    endpoint: "fal-ai/nano-banana-pro",
  },
  {
    id: "cloud-gpt-image-2",
    name: "GPT Image 2",
    provider: "CLOUD",
    description: "Detailed generation, multi-image editing, and mask-guided inpainting.",
    operations: ["generate", "edit", "inpaint"],
    aspectRatios: standardRatios,
    maxImages: 4,
    supportsSeed: false,
    supportsNegativePrompt: false,
    maxReferences: 16,
    priceNote: "Est. $0.01–$0.41/image depending on quality and output resolution.",
    endpoint: "openai/gpt-image-2",
  },
  {
    id: "cloud-flux2-pro",
    name: "FLUX.2 Pro",
    provider: "CLOUD",
    description: "Studio-grade text-to-image generation with precise custom dimensions.",
    operations: ["generate"],
    aspectRatios: standardRatios,
    maxImages: 1,
    supportsSeed: true,
    supportsNegativePrompt: false,
    maxReferences: 0,
    priceNote: "Est. $0.03 first output MP + $0.015 per additional input/output MP, rounded up.",
    endpoint: "fal-ai/flux-2-pro",
  },
  {
    id: "cloud-seedream-5-lite",
    name: "Seedream 5 Lite",
    provider: "CLOUD",
    description: "Reasoning-guided text-to-image generation with flexible high-resolution output.",
    operations: ["generate"],
    aspectRatios: standardRatios,
    maxImages: 6,
    supportsSeed: false,
    supportsNegativePrompt: false,
    maxReferences: 0,
    priceNote: "Est. $0.035/image, including outputs up to 3K.",
    endpoint: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  },
  {
    id: "cloud-ideogram-v3",
    name: "Ideogram V3",
    provider: "CLOUD",
    description: "Typography-focused raster generation with optional style references.",
    operations: ["generate"],
    aspectRatios: standardRatios,
    maxImages: 8,
    supportsSeed: true,
    supportsNegativePrompt: true,
    maxReferences: 3,
    priceNote: "Est. $0.03 Turbo, $0.06 Balanced, or $0.09 Quality per image.",
    endpoint: "fal-ai/ideogram/v3",
  },
  {
    id: "cloud-recraft-v3-raster",
    name: "Recraft V3 Raster",
    provider: "CLOUD",
    description: "Design-oriented raster image generation; SVG output is intentionally not enabled.",
    operations: ["generate"],
    aspectRatios: standardRatios,
    maxImages: 1,
    supportsSeed: false,
    supportsNegativePrompt: false,
    maxReferences: 0,
    priceNote: "Est. $0.04 per raster image.",
    endpoint: "fal-ai/recraft/v3/text-to-image",
  },
  {
    id: "cloud-qwen-inpaint",
    name: "Qwen Image Inpaint / Outpaint",
    provider: "CLOUD",
    description: "Mask-guided inpainting or outpainting using a same-size source canvas and mask.",
    operations: ["inpaint", "outpaint"],
    aspectRatios: standardRatios,
    maxImages: 4,
    supportsSeed: true,
    supportsNegativePrompt: true,
    maxReferences: 1,
    priceNote: "Est. $0.03 per output megapixel.",
    endpoint: "fal-ai/qwen-image-edit/inpaint",
  },
  {
    id: "cloud-esrgan-upscale",
    name: "Real-ESRGAN Upscale",
    provider: "CLOUD",
    description: "Raster image upscaling from 1× through 8×.",
    operations: ["upscale"],
    aspectRatios: ["source"],
    maxImages: 1,
    supportsSeed: false,
    supportsNegativePrompt: false,
    maxReferences: 1,
    priceNote: "Usage-priced at approximately $0.00111 per compute second.",
    endpoint: "fal-ai/esrgan",
  },
  {
    id: "cloud-remove-background",
    name: "Remove Background",
    provider: "CLOUD",
    description: "Extracts the foreground of a raster image as a transparent PNG.",
    operations: ["remove-background"],
    aspectRatios: ["source"],
    maxImages: 1,
    supportsSeed: false,
    supportsNegativePrompt: false,
    maxReferences: 1,
    priceNote: "Usage-priced at approximately $0.00111 per compute second. This is a paid Cloud operation.",
    endpoint: "fal-ai/imageutils/rembg",
  },
];

export function getImageModel(id: string): ImageModel | undefined {
  return imageModels.find((model) => model.id === id);
}