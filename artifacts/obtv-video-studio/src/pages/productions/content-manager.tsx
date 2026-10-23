import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ProductionState } from "@/lib/production-types";

export function ContentManager({ state, step, busy, run }: {
  state: ProductionState; step: number; busy: boolean;
  run: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const kinds = ["scene", "character", "wardrobe", "place"];
  const titles = ["scenes", "characters", "outfits", "places"];
  if (step > 3) return null;
  const kind = kinds[step];
  const items = step === 0 ? state.story.scenes.map(s => ({
    id: String(s.sceneNumber), name: s.title,
    fields: { title: s.title, location: s.location, timeOfDay: s.timeOfDay, action: s.action, dialogue: s.dialogue, ...(s.durationSeconds ? { durationSeconds: String(s.durationSeconds) } : {}) },
  })) : step === 1 ? state.characters.map(c => ({ id: c.id, name: c.name, fields: { name: c.name, description: c.description } }))
    : step === 2 ? state.wardrobes.map(w => ({ id: w.id, name: w.name, fields: { name: w.name, prompt: w.prompt, fromScene: String(w.fromScene), toScene: String(w.toScene) } }))
    : state.places.map(p => ({ id: p.id, name: p.name, fields: { name: p.name, prompt: p.prompt } }));
  const labels: Record<string, string> = { title: "Title", location: "Location", timeOfDay: "Time of day", action: "Action", dialogue: "Dialogue", durationSeconds: "Duration (seconds)", name: "Name", description: "Description", prompt: "Prompt", fromScene: "First scene", toScene: "Last scene" };
  return <>
    <Button variant="outline" size="sm" className="mt-3" disabled={!items.length || busy} onClick={() => { setOpen(true); setEditing(null); setRemoving(null); }} data-testid="button-edit-project-content">Edit / remove {titles[step]}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {titles[step]}</DialogTitle><DialogDescription>
          Changes affect this project only. Shared library assets and earlier renders are kept. A changed project needs a new render plan. Editing text does not regenerate an image.
        </DialogDescription></DialogHeader>
        {items.map(item => <div key={item.id} className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center gap-2"><span className="flex-1 font-medium">{item.name}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(item.id); setRemoving(null); setFields(Object.fromEntries(Object.entries(item.fields).filter(([,v]) => v !== undefined)) as Record<string,string>); }}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRemoving(item.id); setEditing(null); }}>Remove</Button>
          </div>
          {removing === item.id && <div className="space-y-2 text-sm">
            <p>Remove “{item.name}” from this project? Its assignments will be removed. Removing a character also removes their project outfits; removing a scene updates scene numbering and outfit ranges. Saved library assets and previous renders remain.</p>
            <Button variant="destructive" disabled={busy} onClick={async () => { if (await run("edit-content", { kind, id: item.id, remove: true })) setRemoving(null); }}>Confirm removal</Button>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
          </div>}
          {editing === item.id && <div className="space-y-3">
            {Object.entries(fields).map(([key,value]) => <label key={key} className="block text-sm space-y-1"><span>{labels[key]}</span>
              {["description","prompt","action","dialogue"].includes(key)
                ? <Textarea value={value} onChange={e => setFields({ ...fields, [key]: e.target.value })} />
                : <Input type={["fromScene","toScene","durationSeconds"].includes(key) ? "number" : "text"} value={value} onChange={e => setFields({ ...fields, [key]: e.target.value })} />}
            </label>)}
            <Button disabled={busy} onClick={async () => { if (await run("edit-content", { kind, id: item.id, fields })) setEditing(null); }}>Save changes</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>}
        </div>)}
      </DialogContent>
    </Dialog>
  </>;
}
