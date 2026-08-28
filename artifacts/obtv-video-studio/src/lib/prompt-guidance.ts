export type GuidanceLevel = "error" | "warning" | "tip";

export type GuidanceIssue = {
  level: GuidanceLevel;
  message: string;
};

export type PromptFields = {
  subject: string;
  action: string;
  composition: string;
  setting: string;
  lighting: string;
  style: string;
};

const ACTION_WORDS = /\b(walks?|runs?|turns?|looks?|speaks?|talks?|smiles?|reaches?|holds?|sits?|stands?|moves?|enters?|exits?|opens?|closes?|drives?|flies?|falls?|rises?|gestures?|reacts?|watches?|reveals?|shows?)\b/i;
const SUBJECT_WORDS = /\b(person|character|woman|man|child|presenter|host|guest|camera|car|animal|product|building|landscape|crowd|hands?|face|subject)\b/i;

export function buildPrompt(fields: PromptFields): string {
  return [
    fields.subject.trim(),
    fields.action.trim(),
    fields.composition.trim(),
    fields.setting.trim() && `Set in ${fields.setting.trim()}`,
    fields.lighting.trim() && `Lighting: ${fields.lighting.trim()}`,
    fields.style.trim() && `Visual style: ${fields.style.trim()}`,
  ].filter(Boolean).join(". ").replace(/\.\./g, ".").replace(/([^.!?])$/, "$1.");
}

export function analyzePrompt(input: {
  prompt: string;
  cameraInstructions?: string;
  motionInstructions?: string;
  dialogue?: string;
  shotKind?: "SHOT" | "B-ROLL";
  requiresReference?: boolean;
  hasReference?: boolean;
}): GuidanceIssue[] {
  const prompt = input.prompt.trim();
  const combined = `${prompt} ${input.cameraInstructions ?? ""} ${input.motionInstructions ?? ""}`.toLowerCase();
  const issues: GuidanceIssue[] = [];
  if (!prompt) return [{ level: "error", message: "Add a visual description before rendering." }];
  if (prompt.length < 35) issues.push({ level: "warning", message: "The prompt is very short. Add subject, action, setting, and composition." });
  if (!SUBJECT_WORDS.test(prompt) && prompt.split(/\s+/).length < 10) issues.push({ level: "warning", message: "Clarify who or what the camera should focus on." });
  if (!ACTION_WORDS.test(prompt) && !/\b(static|still|establishing|close-up|portrait|view|shot)\b/i.test(prompt)) {
    issues.push({ level: "warning", message: "Describe one clear action or explicitly request a static shot." });
  }
  if (/\bclose[- ]?up\b/.test(combined) && /\bwide|establishing\b/.test(combined)) {
    issues.push({ level: "warning", message: "Close-up and wide/establishing framing may conflict in one short shot." });
  }
  if (/\bstatic|locked[- ]?off\b/.test(combined) && /\bpan|tilt|dolly|tracking|orbit|handheld|zoom\b/.test(combined)) {
    issues.push({ level: "warning", message: "Static camera direction conflicts with a requested camera move." });
  }
  if (/\bslow motion\b/.test(combined) && /\bfast[- ]?paced|rapid|high motion\b/.test(combined)) {
    issues.push({ level: "warning", message: "Slow motion and rapid movement compete; explain which element should be slow." });
  }
  if (input.shotKind === "B-ROLL" && input.dialogue?.trim()) {
    issues.push({ level: "error", message: "B-roll should not contain dialogue. Move the spoken line to a SHOT block." });
  }
  if (input.requiresReference && !input.hasReference) {
    issues.push({ level: "error", message: "This workflow requires a reference video before rendering." });
  }
  if (prompt.length > 1200) issues.push({ level: "tip", message: "This prompt is long. Shorter, prioritized direction is often more reliable." });
  if (!input.cameraInstructions?.trim()) issues.push({ level: "tip", message: "Add camera framing or movement for more predictable composition." });
  if (!input.motionInstructions?.trim()) issues.push({ level: "tip", message: "Add motion behavior to improve temporal consistency." });
  return issues;
}

export function analyzeScript(script: string, storyline = ""): GuidanceIssue[] {
  const value = script.trim();
  if (!value) return [{ level: "error", message: "Add a script before generating a project plan." }];
  const issues: GuidanceIssue[] = [];
  const headerPattern = /^\s*(SHOT|B-ROLL)\s+(\d+)(?:\s*(?::|[—–-])\s*(.*))?\s*$/gim;
  const headers = [...value.matchAll(headerPattern)];
  if (headers.length === 0) {
    if (value.length < 80) issues.push({ level: "warning", message: "The script is brief; the automatic planner may have limited visual material." });
    issues.push({ level: "tip", message: "For exact control, label blocks as SHOT 1: and B-ROLL 2:. Otherwise prose will be split automatically." });
  } else {
    const seen = new Set<string>();
    for (const header of headers) {
      const key = `${header[1].toUpperCase()}-${header[2]}`;
      if (seen.has(key)) issues.push({ level: "warning", message: `${header[1].toUpperCase()} ${header[2]} is numbered more than once.` });
      seen.add(key);
    }
    for (const [index, header] of headers.entries()) {
      const kind = header[1].toUpperCase();
      const number = header[2];
      const bodyStart = (header.index ?? 0) + header[0].length;
      const followingBody = value.slice(bodyStart, headers[index + 1]?.index ?? value.length).trim();
      const body = followingBody || header[3]?.trim() || "";
      if (!body) issues.push({ level: "error", message: `${kind} ${number} has no visual description.` });
      if (kind === "B-ROLL" && /[“"][^”"]+[”"]/.test(body)) {
        issues.push({ level: "warning", message: `B-ROLL ${number} contains quoted dialogue; B-roll dialogue will be ignored.` });
      }
    }
    issues.push({ level: "tip", message: `${headers.length} authored shot block${headers.length === 1 ? "" : "s"} detected. Their boundaries will be preserved.` });
  }
  if (!storyline.trim()) issues.push({ level: "tip", message: "Add a visual storyline for consistent wardrobe, lighting, palette, and locations across shots." });
  return issues;
}

export function readinessScore(issues: GuidanceIssue[]): number {
  return Math.max(0, 100 - issues.reduce((score, issue) => score + (issue.level === "error" ? 35 : issue.level === "warning" ? 15 : 4), 0));
}