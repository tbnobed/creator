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
  return <details open={state.story.scenes.some(s=>!s.opening?.assetId)} className="mb-4 rounded-xl border border-border p-3">
    <summary className="cursor-pointer text-sm font-semibold">Scene opening images</summary>
    <p className="my-2 text-xs text-muted-foreground">Before animation, review one complete image per scene with its cast, outfits, props and location together. Generation uses local native reference editing. Inspect the full image before approving; changed inputs require a fresh composition and approval.</p>
    {state.story.scenes.map(scene=>{
      const ref=scene.opening, approved=!!ref?.assetId && ref.approvedAssetId===ref.assetId;
      return <div key={scene.sceneNumber} className="flex flex-wrap items-center gap-2 border-t border-border py-2">
        {ref?.mediaUrl && <a href={ref.mediaUrl} target="_blank" rel="noreferrer" title="Inspect scene opening"><img src={ref.mediaUrl} alt={`Scene ${scene.sceneNumber} opening`} className="h-16 w-28 rounded object-contain"/></a>}
        <span className="min-w-0 flex-1 text-sm">{scene.sceneNumber}. {scene.title}<span className="ml-2 text-xs text-muted-foreground">{approved ? "Approved" : ref?.status==="QUEUED" || ref?.status==="RUNNING" ? "Generating…" : "Needs review"}</span></span>
        {ref?.mediaUrl && <Button asChild size="icon" variant="ghost" title="Preview opening"><a href={ref.mediaUrl} target="_blank" rel="noreferrer" aria-label={`Preview opening ${scene.sceneNumber}`}><Eye className="h-4 w-4"/></a></Button>}
        <Button size="icon" variant="ghost" title="Generate local scene opening" aria-label={`Generate opening ${scene.sceneNumber}`} disabled={busy} onClick={()=>void run("generate-scene-opening",{sceneNumber:scene.sceneNumber})}><RefreshCw className="h-4 w-4"/></Button>
        <label className={`inline-flex h-9 w-9 items-center justify-center rounded-md ${busy||upload.isPending ? "pointer-events-none opacity-50" : "cursor-pointer hover:bg-accent"}`} title="Upload composed opening">
          <Upload className="h-4 w-4"/><input type="file" className="sr-only" aria-label={`Upload opening ${scene.sceneNumber}`} accept="image/png,image/jpeg,image/webp" disabled={busy||upload.isPending} onChange={async e=>{const f=e.target.files?.[0];if(!f)return;setError("");try{const result=await upload.mutateAsync({data:f});await run("set-scene-opening",{sceneNumber:scene.sceneNumber,assetId:result.asset.id});}catch(cause){setError(cause instanceof Error?cause.message:"Upload failed.");}finally{e.target.value="";}}}/>
        </label>
        <Button size="icon" variant="ghost" title={approved?"Opening approved":ref?.status==="STALE"?"Inputs changed; regenerate opening":"Approve opening"} aria-label={`Approve opening ${scene.sceneNumber}`} className={approved?"text-emerald-400 disabled:opacity-100":""} disabled={busy||!ref?.assetId||approved||ref.status!=="READY"} onClick={()=>void run("approve-scene-opening",{sceneNumber:scene.sceneNumber,assetId:ref?.assetId})}><CheckCircle2 className="h-4 w-4"/></Button>
        {ref?.assetId && ref.status!=="STALE" && <details className="w-full text-xs"><summary className="cursor-pointer text-muted-foreground">Correct opening</summary><div className="mt-2 flex gap-2"><Input aria-label={`Opening correction ${scene.sceneNumber}`} placeholder="Describe only what should change…" value={corrections[scene.sceneNumber]??""} onChange={e=>setCorrections({...corrections,[scene.sceneNumber]:e.target.value})}/><Button size="sm" variant="outline" disabled={busy||!corrections[scene.sceneNumber]?.trim()} onClick={()=>void run("generate-scene-opening",{sceneNumber:scene.sceneNumber,correction:corrections[scene.sceneNumber]})}>Generate correction</Button></div></details>}
      </div>;
    })}
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </details>;
}
