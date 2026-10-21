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
export function SceneScenery({ state, onSettings, disabled }: { state: ProductionState; onSettings: (p: Partial<ProductionSettings>) => void; disabled?: boolean }) {
  if (!state.story.scenes.length) return null;
  return <section className="mb-6 space-y-3 rounded-xl border border-border bg-card p-4" data-testid="scene-scenery">
    <h3 className="font-semibold">Scene scenery</h3>
    <p className="text-sm text-muted-foreground">Choose an existing place for each scene. Names do not have to match. Reuse a room, or choose its lighting/weather variant. Assigning a reference does not generate an image or incur charges.</p>
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
            {ready ? `Ready: ${resolved!.place.name}${resolved!.reference.id !== resolved!.place.id ? ` · ${resolved!.reference.name}` : ""}` : "Assign a ready reference here, or generate one in Places."}
          </p>
        </div>
      </div>;
    })}
  </section>;
}
