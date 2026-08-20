import { count, eq } from "drizzle-orm";
import {
  charactersTable,
  db,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";

let seeded = false;

export async function ensureStudioSeed(): Promise<void> {
  if (seeded) return;
  const [{ total }] = await db.select({ total: count() }).from(charactersTable);
  if (total === 0) {
    await db.insert(charactersTable).values([
      {
        name: "Maya",
        description: "Female podcast host",
        promptDescription: "Maya is a woman in her early 30s with shoulder-length dark brown hair, warm brown eyes, olive skin and subtle natural makeup. She wears a cream-colored blouse.",
        tags: ["host", "wellness"],
        voiceProfile: "Warm conversational",
      },
      {
        name: "Daniel",
        description: "Holistic health expert",
        promptDescription: "Daniel is a man in his early 40s with short dark hair, a trimmed beard, and a charcoal shirt. He is calm, attentive and thoughtful.",
        tags: ["guest", "expert"],
      },
    ]);
  }
  const [{ settingTotal }] = await db.select({ settingTotal: count() }).from(settingsTable);
  if (settingTotal === 0) {
    await db.insert(settingsTable).values({
      name: "Wellness Podcast Studio",
      description: "A warm contemporary recording set",
      promptDescription: "An elegant contemporary wellness podcast studio with warm neutral tones, walnut acoustic panels, soft practical lighting, plants, black broadcast microphones and a shallow-depth-of-field cinematic background.",
      tags: ["podcast", "studio", "interior"],
    });
  }
  const [{ workflowTotal }] = await db.select({ workflowTotal: count() }).from(workflowTemplatesTable);
  if (workflowTotal === 0) {
    await db.insert(workflowTemplatesTable).values([
      {
        name: "MiniMax H3 REF2VA",
        description: "Reference-character and image video generation. Import the actual ComfyUI API workflow before activation.",
        generationMode: "REFERENCE_TO_VIDEO",
        modelFamily: "MiniMax H3",
        compatibleServerTags: ["minimax-h3"],
        active: false,
        expectedInputs: ["prompt", "referenceImage1", "width", "height", "frames", "seed"],
        expectedOutputs: ["video"],
      },
      {
        name: "MiniMax H3 FL2VA",
        description: "First and last frame video generation or clip continuation. Import the actual ComfyUI API workflow before activation.",
        generationMode: "FIRST_LAST_FRAME_TO_VIDEO",
        modelFamily: "MiniMax H3",
        compatibleServerTags: ["minimax-h3"],
        active: false,
        expectedInputs: ["prompt", "firstFrame", "lastFrame", "width", "height", "frames", "seed"],
        expectedOutputs: ["video"],
      },
    ]);
  }
  seeded = true;
}