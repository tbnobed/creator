import { useEffect, useState } from "react";
import type { ProductionSettings, ProductionState, Scene } from "@/lib/production-types";
const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function resolveSceneScenery(state: ProductionState, scene: Scene) {
  const assigned = state.settings.sceneReferences?.[String(scene.sceneNumber)];
  const places = state.places.filter(p => assigned ? p.id === assigned.placeId : normalized(p.name) === normalized(scene.location));
  if (places.length !== 1) return undefined;
  const place = places[0], variants = place.variants.filter(v => assigned ? !!assigned.variantId && v.id === assigned.variantId : normalized(v.name) === normalized(scene.timeOfDay));
  if (variants.length > 1 || (assigned?.variantId && !variants.length)) return undefined;
  return { place, reference: variants[0] ?? place };
}
export const missingSceneryCount = (state: ProductionState) => state.story.scenes.filter(scene => !resolveSceneScenery(state, scene)?.reference.assetId).length;
export function SceneScenery({ state, onSettings, disabled }: { state: ProductionState; onSettings: (p: Partial<ProductionSettings>) => void; disabled?: boolean }) {
  const missing = missingSceneryCount(state);
  const [open, setOpen] = useState(missing > 0);
  useEffect(() => { if (missing > 0) setOpen(true); }, [missing]);
  if (!state.story.scenes.length) return null;
  return <details open={open} onToggle={e => setOpen(e.currentTarget.open)} className="group mb-6 rounded-xl border border-border bg-card" data-testid="scene-scenery">
    <summary className="flex cursor-pointer items-center justify-between gap-3 p-4 text-sm" data-testid="toggle-scene-scenery">
      <span className="font-semibold">Scene scenery</span>
      <span className={missing ? "text-destructive" : "text-emerald-400"} data-testid="text-scenery-summary">
        {missing ? `${missing} of ${state.story.scenes.length} scenes need scenery` : `All ${state.story.scenes.length} scenes assigned`}
      </span>
    </summary>
    <div className="space-y-3 px-4 pb-4">
    <p className="text-xs text-muted-foreground">Pick a place or variant for each scene. Names do not have to match. No images are generated.</p>
    {state.story.scenes.map(scene => {
      const assigned = state.settings.sceneReferences?.[String(scene.sceneNumber)];
      const resolved = resolveSceneScenery(state, scene), ready = !!resolved?.reference.assetId;
      const value = assigned ? (resolved ? `${assigned.placeId}${assigned.variantId ? `:${assigned.variantId}` : ""}` : "__missing__") : "";
      return <div key={scene.sceneNumber} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
        <div><label htmlFor={`scene-scenery-${scene.sceneNumber}`} className="text-sm font-medium">Scene {scene.sceneNumber} · {scene.title}</label>
          <p className="text-xs text-muted-foreground">{scene.location} · {scene.timeOfDay}</p></div>
        <div>
          <select id={`scene-scenery-${scene.sceneNumber}`} value={value} disabled={disabled}
            data-testid={`select-scene-scenery-${scene.sceneNumber}`}
            className="min-h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
            onChange={e => {
              const [placeId, variantId] = e.target.value.split(":");
              onSettings({ sceneReferences: { ...state.settings.sceneReferences, [String(scene.sceneNumber)]: placeId ? { placeId, ...(variantId ? { variantId } : {}) } : null } });
            }}>
            <option value="">{!assigned && resolved ? `Automatic — ${resolved.place.name}${resolved.reference.id !== resolved.place.id ? ` · ${resolved.reference.name}` : ""}` : "Choose scenery (or automatic exact-name match)"}</option>
            {value === "__missing__" && <option value="__missing__" disabled>Reference removed — choose another</option>}
            {state.places.map(p => <optgroup key={p.id} label={p.name}>
              <option value={p.id} disabled={!p.assetId}>{p.name} · Base{!p.assetId ? " (not ready)" : ""}</option>
              {p.variants.map(v => <option key={v.id} value={`${p.id}:${v.id}`} disabled={!v.assetId}>{p.name} · {v.name}{!v.assetId ? " (not ready)" : ""}</option>)}
            </optgroup>)}
          </select>
          <p className={`mt-1 text-xs ${ready ? "text-emerald-400" : "text-destructive"}`} data-testid={`status-scene-scenery-${scene.sceneNumber}`}>
            {ready ? `Ready: ${resolved!.place.name}${resolved!.reference.id !== resolved!.place.id ? ` · ${resolved!.reference.name}` : ""}` : "Assign a ready reference, or generate one below."}
          </p>
        </div>
      </div>;
    })}
    </div>
  </details>;
}
