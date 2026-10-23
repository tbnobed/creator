import { numberIn, text, type ProductionState } from "./production-types";

export function changeProductionContent(source: ProductionState, payload: Record<string, unknown>): ProductionState {
  const state = structuredClone(source);
  if (state.tasks.some(t => ["QUEUED", "RUNNING"].includes(t.status))) throw new Error("Wait for generation to finish or cancel it before editing project content.");
  const kind = String(payload.kind), remove = payload.remove === true;
  const collection = kind === "scene" ? state.story.scenes : kind === "character" ? state.characters : kind === "wardrobe" ? state.wardrobes : kind === "place" ? state.places : null;
  if (!collection) throw new Error("Unknown content type.");
  const item = collection.find(v => String("id" in v ? v.id : v.sceneNumber) === String(payload.id));
  if (!item) throw new Error("This item no longer exists.");
  const removed = new Set<string>();
  if (remove) {
    if ("id" in item) removed.add(item.id);
    if (kind === "scene") {
      const oldNumber = Number(payload.id);
      state.story.scenes = state.story.scenes.filter(s => s.sceneNumber !== oldNumber).map((s, i) => ({ ...s, sceneNumber: i + 1 }));
      const assignments = state.settings.sceneReferences ?? {};
      state.settings.sceneReferences = Object.fromEntries(Object.entries(assignments).filter(([n]) => Number(n) !== oldNumber).map(([n, v]) => [String(Number(n) > oldNumber ? Number(n) - 1 : Number(n)), v]));
      state.wardrobes = state.wardrobes.filter(w => {
        if (w.fromScene === oldNumber && w.toScene === oldNumber) { removed.add(w.id); return false; }
        if (w.fromScene > oldNumber) w.fromScene--;
        if (w.toScene >= oldNumber) w.toScene--;
        if (w.stateFromScene && w.stateFromScene > oldNumber) w.stateFromScene--;
        return true;
      });
      if (!state.story.scenes.length) state.story.draftStatus = "DRAFT";
    } else if (kind === "character") {
      const character = state.characters.find(c => c.id === payload.id)!;
      state.characters = state.characters.filter(c => c.id !== character.id);
      state.story.scenes.forEach(s => { s.characters = s.characters.filter(n => n.toLowerCase() !== character.name.toLowerCase()); });
      state.wardrobes.forEach(w => { if (w.characterId === character.id) removed.add(w.id); });
      state.wardrobes = state.wardrobes.filter(w => w.characterId !== character.id);
    } else if (kind === "wardrobe") state.wardrobes = state.wardrobes.filter(w => w.id !== payload.id);
    else {
      const place = state.places.find(p => p.id === payload.id)!;
      place.variants.forEach(v => removed.add(v.id));
      state.places = state.places.filter(p => p.id !== place.id);
      for (const [n, ref] of Object.entries(state.settings.sceneReferences ?? {})) if (ref?.placeId === place.id) state.settings.sceneReferences![n] = null;
    }
  } else {
    const fields = payload.fields as Record<string, unknown>;
    if (!fields || typeof fields !== "object") throw new Error("Missing edited fields.");
    if (kind === "scene") {
      const scene = state.story.scenes.find(s => s.sceneNumber === Number(payload.id))!;
      const replan = ["action", "dialogue", "durationSeconds"].some(key => key in fields && String(fields[key]) !== String(scene[key as keyof typeof scene]));
      for (const key of ["title", "location", "timeOfDay", "action", "dialogue"] as const) if (key in fields) scene[key] = text(fields[key], key, 20000, key !== "dialogue");
      if ("durationSeconds" in fields) scene.durationSeconds = numberIn(Number(fields.durationSeconds), "Duration", 2, 5400);
      // Authored shot breakdown is stale after screenplay edits.
      if (replan) delete scene.shots;
    } else if (kind === "character") {
      const character = state.characters.find(c => c.id === payload.id)!;
      const name = text(fields.name, "Name", 180);
      if (state.characters.some(c => c.id !== character.id && c.name.toLowerCase() === name.toLowerCase())) throw new Error("Another character already has this name.");
      state.story.scenes.forEach(s => { s.characters = s.characters.map(n => n.toLowerCase() === character.name.toLowerCase() ? name : n); });
      character.name = name; character.description = text(fields.description, "Description", 4000, false);
    } else {
      const target = kind === "wardrobe" ? state.wardrobes.find(w => w.id === payload.id)! : state.places.find(p => p.id === payload.id)!;
      target.name = text(fields.name, "Name", 180);
      target.prompt = text(fields.prompt, "Prompt");
      if (kind === "wardrobe") {
        const w = state.wardrobes.find(w => w.id === payload.id)!;
        w.fromScene = numberIn(Number(fields.fromScene), "First scene", 1, state.story.scenes.length);
        w.toScene = numberIn(Number(fields.toScene), "Last scene", w.fromScene, state.story.scenes.length);
        delete w.approvedAssetId;
      }
    }
  }
  state.tasks = state.tasks.filter(t => !removed.has(t.entityId ?? "") && !removed.has(t.placeId ?? ""));
  return state;
}
