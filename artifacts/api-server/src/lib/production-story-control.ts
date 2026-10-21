export class StoryCancelled extends Error {
  constructor() { super("Writing cancelled. Your script and completed work are retained."); this.name = "StoryCancelled"; }
}
const active = new Map<string, AbortController>();
export function registerStoryWriter(projectId: string, controller: AbortController) {
  active.set(projectId, controller);
  return () => { if (active.get(projectId) === controller) active.delete(projectId); };
}
export function cancelActiveStory(projectId: string) { active.get(projectId)?.abort(new StoryCancelled()); }
