import { useState } from "react";
import { Eye, CheckCircle2, RefreshCw, Upload } from "lucide-react";
import { useUploadAsset } from "@/hooks/image-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProductionState } from "@/lib/production-types";
import type { RunAction } from "./workflow";
export function SceneOpenings({state,run,busy}:{state:ProductionState;run:RunAction;busy:boolean}) {
  const upload=useUploadAsset();
  const [error,setError]=useState("");
  const [corrections,setCorrections]=useState<Record<number,string>>({});
  const [count,setCount]=useState(1);
  return <details open={state.story.scenes.some(s=>!s.opening?.assetId)} className="mb-4 rounded-xl border border-border p-3">
    <summary className="cursor-pointer text-sm font-semibold">Scene opening images</summary>
    <p className="my-2 text-xs text-muted-foreground">Before animation, review one complete image per scene with its cast, outfits, props and location together. Generation uses local native reference editing. Inspect the full image before approving; changed inputs require a fresh composition and approval.</p>
    <label className="mb-3 flex items-center gap-2 text-xs">Versions per generation
      <select aria-label="Versions per generation" className="rounded border border-border bg-background p-1" value={count} onChange={e=>setCount(Number(e.target.value))}>
        {[1,2,3,4].map(n=><option key={n} value={n}>{n}</option>)}
      </select>
      <span className="text-muted-foreground">Queue other scenes while these generate. Workers run within safe capacity.</span>
    </label>
    {state.story.scenes.map(scene=>{
      const ref=scene.opening, approved=!!ref?.assetId && ref.approvedAssetId===ref.assetId;
      const history=[...(scene.openingHistory??[])];
      if(ref?.assetId&&!history.some(item=>item.assetId===ref.assetId))history.unshift(ref);
      const active=history.filter(item=>["QUEUED","RUNNING"].includes(item.status));
      return <div key={scene.sceneNumber} className="flex flex-wrap items-center gap-2 border-t border-border py-2">
        {ref?.mediaUrl && <a href={ref.mediaUrl} target="_blank" rel="noreferrer" title="Inspect scene opening"><img src={ref.mediaUrl} alt={`Scene ${scene.sceneNumber} opening`} className="h-16 w-28 rounded object-contain"/></a>}
        <span className="min-w-0 flex-1 text-sm">{scene.sceneNumber}. {scene.title}<span className="ml-2 text-xs text-muted-foreground">{approved ? "Approved" : ref?.status==="QUEUED" || ref?.status==="RUNNING" ? "Generating…" : "Needs review"}</span></span>
        {ref?.mediaUrl && <Button asChild size="icon" variant="ghost" title="Preview opening"><a href={ref.mediaUrl} target="_blank" rel="noreferrer" aria-label={`Preview opening ${scene.sceneNumber}`}><Eye className="h-4 w-4"/></a></Button>}
        {active.length>0&&<span className="text-xs text-muted-foreground">{active.length} queued / generating</span>}
        <Button size="icon" variant="ghost" title={`Generate ${count} new opening${count>1?"s":""}`} aria-label={`Generate opening ${scene.sceneNumber}`} disabled={busy} onClick={()=>void run("generate-scene-opening",{sceneNumber:scene.sceneNumber,count})}><RefreshCw className="h-4 w-4"/></Button>
        <label className={`inline-flex h-9 w-9 items-center justify-center rounded-md ${busy||upload.isPending ? "pointer-events-none opacity-50" : "cursor-pointer hover:bg-accent"}`} title="Upload composed opening">
          <Upload className="h-4 w-4"/><input type="file" className="sr-only" aria-label={`Upload opening ${scene.sceneNumber}`} accept="image/png,image/jpeg,image/webp" disabled={busy||upload.isPending} onChange={async e=>{const f=e.target.files?.[0];if(!f)return;setError("");try{const result=await upload.mutateAsync({data:f});await run("set-scene-opening",{sceneNumber:scene.sceneNumber,assetId:result.asset.id});}catch(cause){setError(cause instanceof Error?cause.message:"Upload failed.");}finally{e.target.value="";}}}/>
        </label>
        <Button size="icon" variant="ghost" title={approved?"Opening approved":ref?.status==="STALE"?"Inputs changed; regenerate opening":"Approve opening"} aria-label={`Approve opening ${scene.sceneNumber}`} className={approved?"text-emerald-400 disabled:opacity-100":""} disabled={busy||!ref?.assetId||approved||ref.status!=="READY"} onClick={()=>void run("approve-scene-opening",{sceneNumber:scene.sceneNumber,assetId:ref?.assetId})}><CheckCircle2 className="h-4 w-4"/></Button>
        {history.length>0&&<details className="w-full text-xs">
          <summary className="cursor-pointer text-muted-foreground">Versions ({history.length}) — preview and approve</summary>
          <div className="mt-2 flex flex-wrap gap-3">{history.map((item,index)=><div key={item.id??item.assetId??index} className="w-32 rounded border border-border p-2">
            {item.mediaUrl&&<a href={item.mediaUrl} target="_blank" rel="noreferrer" title={`Preview version ${index+1}`}><img src={item.mediaUrl} alt={`Scene ${scene.sceneNumber}, version ${index+1}`} className="h-20 w-full rounded object-contain"/></a>}
            <div className="mt-1 flex items-center justify-between">
              <span>V{index+1} · {ref?.approvedAssetId===item.assetId&&item.assetId ? "Approved" : item.status.toLowerCase()}</span>
              <Button size="icon" variant="ghost" title={item.status==="STALE"?"Inputs changed; cannot approve this version":"Approve this version"} aria-label={`Approve scene ${scene.sceneNumber} version ${index+1}`} disabled={busy||item.status!=="READY"||!item.assetId||ref?.approvedAssetId===item.assetId} onClick={()=>void run("approve-scene-opening",{sceneNumber:scene.sceneNumber,assetId:item.assetId})}><CheckCircle2 className="h-4 w-4"/></Button>
            </div>
            {item.error&&<p className="mt-1 text-destructive">{item.error}</p>}
          </div>)}</div>
        </details>}
        {ref?.assetId && ref.status!=="STALE" && <details className="w-full text-xs"><summary className="cursor-pointer text-muted-foreground">Correct opening</summary><div className="mt-2 flex gap-2"><Input aria-label={`Opening correction ${scene.sceneNumber}`} placeholder="Describe only what should change…" value={corrections[scene.sceneNumber]??""} onChange={e=>setCorrections({...corrections,[scene.sceneNumber]:e.target.value})}/><Button size="sm" variant="outline" disabled={busy||!corrections[scene.sceneNumber]?.trim()} onClick={()=>void run("generate-scene-opening",{sceneNumber:scene.sceneNumber,count,correction:corrections[scene.sceneNumber]})}>Generate correction</Button></div></details>}
      </div>;
    })}
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </details>;
}
