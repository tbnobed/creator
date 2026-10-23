import { useState } from "react";
import { useUploadAsset } from "@/hooks/image-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProductionState } from "@/lib/production-types";
import type { RunAction } from "./workflow";

export function PropReference({state,run,busy}:{state:ProductionState;run:RunAction;busy:boolean}) {
  const upload=useUploadAsset();
  const [description,setDescription]=useState(state.propReference?.description ?? "");
  const [error,setError]=useState("");
  const ref=state.propReference;
  return <details className="mb-4 rounded-xl border border-border p-3">
    <summary className="cursor-pointer text-sm font-semibold">Prop continuity {ref ? ref.approvedAssetId===ref.assetId ? "· Approved" : "· Needs review" : "· Optional"}</summary>
    <p className="my-2 text-xs text-muted-foreground">Use one reference image for recurring objects across all scenes. Describe their size relative to the character. Uploading does not approve it; inspect it first. Changed references require a new render plan. Generated video still needs visual review.</p>
    {ref && <div className="my-2 flex flex-wrap items-center gap-3">
      <a href={ref.mediaUrl} target="_blank" rel="noreferrer"><img src={ref.mediaUrl} alt="Inspect full prop reference" className="h-32 w-48 rounded object-contain" /></a>
      <span className="text-xs">{ref.description}</span>
      <Button size="sm" disabled={busy || ref.approvedAssetId===ref.assetId} onClick={()=>void run("approve-prop-reference",{assetId:ref.assetId})}>{ref.approvedAssetId===ref.assetId ? "Approved" : "Approve prop reference"}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void run("remove-prop-reference",{})}>Remove reference</Button>
    </div>}
    <Input aria-label="Prop appearance and relative size" placeholder="Small solid red wooden ball, about one-quarter of Pip's height" value={description} onChange={e=>setDescription(e.target.value)} disabled={busy}/>
    {ref && description.trim() !== ref.description && <Button size="sm" variant="outline" className="mt-2" disabled={busy || !description.trim()} onClick={()=>void run("set-prop-reference",{assetId:ref.assetId,description})}>Save description for review</Button>}
    <input className="mt-2 text-xs" aria-label="Upload prop reference" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || upload.isPending || !description.trim()} onChange={async e=>{
      const file=e.target.files?.[0];if(!file)return;setError("");
      try { const result=await upload.mutateAsync({data:file});await run("set-prop-reference",{assetId:result.asset.id,description}); }
      catch(cause){setError(cause instanceof Error ? cause.message : "Upload failed.");}
      finally {e.target.value="";}
    }}/>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </details>;
}
