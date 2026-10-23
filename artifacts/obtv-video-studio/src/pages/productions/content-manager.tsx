import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ProductionState } from "@/lib/production-types";

export function ContentActions({step,id}:{step:number;id:string}) {
  const noun=["scene","character","outfit","place"][step];
  return <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-md bg-card/40 p-0.5" onClick={e=>e.stopPropagation()}>
    {["Edit","Remove"].map(action=><Button key={action} size="icon" variant="ghost" className={`h-7 w-7 ${action==="Remove" ? "text-destructive hover:text-destructive" : ""}`} title={`${action} ${noun}`} aria-label={`${action} ${noun}`} data-testid={`content-${action.toLowerCase()}-${step}-${id}`} onClick={()=>window.dispatchEvent(new CustomEvent("production-content-action",{detail:{step,id,remove:action==="Remove"}}))}>{action==="Edit" ? <Pencil className="h-3.5 w-3.5"/> : <Trash2 className="h-3.5 w-3.5"/>}</Button>)}
  </div>;
}

export function ContentManager({ state, step: currentStep, busy, run }: {
  state: ProductionState; step: number; busy: boolean;
  run: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [target,setTarget]=useState<{step:number;id:string;remove:boolean}|null>(null);
  const step=target?.step ?? currentStep;
  useEffect(()=>{
    const listener=(e:Event)=>{setTarget((e as CustomEvent).detail);setOpen(true);};
    window.addEventListener("production-content-action",listener);
    return ()=>window.removeEventListener("production-content-action",listener);
  },[]);
  const kinds = ["scene", "character", "wardrobe", "place"];
  const titles = ["scenes", "characters", "outfits", "places"];
  const kind = kinds[step];
  const items = step === 0 ? state.story.scenes.map(s => ({
    id: String(s.sceneNumber), name: s.title,
    fields: { title: s.title, location: s.location, timeOfDay: s.timeOfDay, action: s.action, dialogue: s.dialogue, ...(s.durationSeconds ? { durationSeconds: String(s.durationSeconds) } : {}) },
  })) : step === 1 ? state.characters.map(c => ({ id: c.id, name: c.name, fields: { name: c.name, description: c.description } }))
    : step === 2 ? state.wardrobes.map(w => ({ id: w.id, name: w.name, fields: { name: w.name, prompt: w.prompt, fromScene: String(w.fromScene), toScene: String(w.toScene) } }))
    : state.places.map(p => ({ id: p.id, name: p.name, fields: { name: p.name, prompt: p.prompt } }));
  const labels: Record<string, string> = { title: "Title", location: "Location", timeOfDay: "Time of day", action: "Action", dialogue: "Dialogue", durationSeconds: "Duration (seconds)", name: "Name", description: "Description", prompt: "Prompt", fromScene: "First scene", toScene: "Last scene" };
  useEffect(()=>{
    if(!target)return;
    const item=items.find(i=>i.id===target.id);
    if(!item)return;
    setEditing(target.remove ? null : item.id);setRemoving(target.remove ? item.id : null);
    setFields(Object.fromEntries(Object.entries(item.fields).filter(([,v])=>v!==undefined)) as Record<string,string>);
  },[target]);
  return <>
    <Dialog open={open} onOpenChange={value=>{setOpen(value);if(!value)setTarget(null);}}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {titles[step]}</DialogTitle><DialogDescription>
          Changes affect this project only. Shared library assets and earlier renders are kept. A changed project needs a new render plan. Editing text does not regenerate an image.
        </DialogDescription></DialogHeader>
        {items.filter(item=>!target || target.id===item.id).map(item => <div key={item.id} className="rounded-lg border p-3 space-y-3">
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
