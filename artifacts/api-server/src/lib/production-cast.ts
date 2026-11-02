import type { ProductionCharacter, ProductionScene, ProductionState } from "./production-types";

const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const shortName = (name: string) => normalize(name).split(/[\s(]/)[0];
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact names or unique first names only. Never pick an arbitrary look on ambiguity. */
export function resolveProductionCast(state: ProductionState, scene: ProductionScene, sceneCastHints: readonly string[] = []): ProductionCharacter[] {
  const selected = new Set<string>();
  const resolve = (name: string) => {
    const key = normalize(name);
    const exact = state.characters.filter(c => normalize(c.name) === key);
    let candidates = exact.length ? exact : state.characters.filter(c => shortName(c.name) === key);
    if (candidates.length > 1) {
      const assigned = candidates.filter(c => sceneCastHints.includes(c.id));
      if (assigned.length === 1) candidates = assigned;
    }
    if (candidates.length !== 1) {
      throw new Error(candidates.length
        ? `Scene ${scene.sceneNumber}: "${name}" matches multiple characters. Use the full character name in the scene cast.`
        : `Scene ${scene.sceneNumber}: "${name}" has no matching production character. Add or assign the character before generating the opening.`);
    }
    selected.add(candidates[0].id);
  };
  for (const name of scene.characters) resolve(name);

  // Planning/editing can leave the cast list empty even while a known character
  // remains in the action or shot. Recover only names from this production.
  const dialogue = [scene.dialogue, ...(scene.shots ?? []).map(s => s.dialogue)].join("\n");
  const speakers = [...dialogue.matchAll(/^\s*([\p{L} .'-]+):/gmu)].map(match => match[1]);
  let remaining = normalize([scene.action, ...(scene.shots ?? []).map(s => s.prompt), ...speakers].join("\n"));
  const pattern = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(normalize(name))}(?![\\p{L}\\p{N}_])`, "gu");
  // Consume full names first, longest first: "Cleo North" must not also select
  // a different character called "Cleo", nor depend on cast-library ordering.
  for (const character of [...state.characters].sort((a, b) => b.name.length - a.name.length)) {
    if (!pattern(character.name).test(remaining)) continue;
    resolve(character.name);
    remaining = remaining.replace(pattern(character.name), " ");
  }
  for (const first of new Set(state.characters.map(c => shortName(c.name)))) {
    if (first.length < 2 || !pattern(first).test(remaining)) continue;
    const candidates = state.characters.filter(c => shortName(c.name) === first);
    // A fully specified cast entry can disambiguate a shared first name.
    if (candidates.some(c => selected.has(c.id))) continue;
    resolve(first);
  }
  return state.characters.filter(c => selected.has(c.id));
}

/** The opening illustrates the first view, not every character in later shots. */
export function resolveOpeningCast(state: ProductionState, scene: ProductionScene): ProductionCharacter[] {
  const sceneCast = resolveProductionCast(state, scene);
  const visible = resolveProductionCast(state, {
    ...scene,
    characters: [],
    action: scene.shots?.[0]?.prompt || scene.action,
    dialogue: "",
    shots: [],
  }, sceneCast.map(c => c.id));
  // Explicit names in the opening view take priority. Retain declared scene
  // casting for legacy prompts such as "the group enters" without named actors.
  return visible.length ? visible : sceneCast;
}
