import { useCallback, useState } from "react";
import { GenerationPanel } from "./GenerationPanel";
import { ImageGallery } from "./ImageGallery";
import { ActiveImagePreview } from "./ActiveImagePreview";
import { ImageAsset, ImageJob } from "@/hooks/image-studio";
import { UploadImageDialog, UploadIntent } from "./UploadImageDialog";

export type WorkspaceMode = "generate" | "edit" | "inpaint" | "outpaint" | "upscale" | "remove-background";

export function ImageWorkspace() {
  const [activeAsset, setActiveAsset] = useState<ImageAsset | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("generate");
  const [maskAssetId, setMaskAssetId] = useState<string | undefined>();
  const [preparedOutpaintAsset, setPreparedOutpaintAsset] = useState<ImageAsset>();
  const [referenceAssets, setReferenceAssets] = useState<ImageAsset[]>([]);
  const [maxReferences, setMaxReferences] = useState(0);
  const [reuseJob, setReuseJob] = useState<ImageJob>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadedInput, setUploadedInput] = useState<{ id: string; intent: UploadIntent }>();

  const openUpload = () => setUploadOpen(true);
  const uploaded = (asset: ImageAsset, intent: UploadIntent) => {
    selectAsset(asset);
    setMode(intent);
    setReuseJob(undefined);
    setReferenceAssets((current) => intent === "generate" ? [...current, asset] : []);
    setUploadedInput({ id: asset.id, intent });
    setUploadOpen(false);
  };

  const selectAsset = (asset: ImageAsset) => {
    setActiveAsset(asset);
    setMaskAssetId(undefined);
    setPreparedOutpaintAsset(undefined);
  };

  const clearAsset = () => {
    setActiveAsset(null);
    setMaskAssetId(undefined);
    setPreparedOutpaintAsset(undefined);
  };

  const updateActiveAsset = (asset: ImageAsset) => {
    setActiveAsset((current) => current?.id === asset.id ? asset : current);
    setReferenceAssets((current) => current.map((item) => item.id === asset.id ? asset : item));
  };

  const toggleReference = (asset: ImageAsset) => {
    setReferenceAssets((current) => {
      if (current.some((item) => item.id === asset.id)) {
        return current.filter((item) => item.id !== asset.id);
      }
      const availableReferenceSlots = mode === "generate"
        ? maxReferences
        : Math.max(0, maxReferences - (activeAsset ? 1 : 0));
      if (current.length >= availableReferenceSlots) return current;
      return [...current, asset];
    });
  };

  const removeReference = (id: string) => {
    setReferenceAssets((current) => current.filter((asset) => asset.id !== id));
  };

  const changeMode = (nextMode: WorkspaceMode) => {
    setMode(nextMode);
    setMaskAssetId(undefined);
    setPreparedOutpaintAsset(undefined);
  };

  const reuseSettings = (job: ImageJob, assets: ImageAsset[]) => {
    const references = job.referenceAssetIds
      .map((id) => assets.find((asset) => asset.id === id))
      .filter((asset): asset is ImageAsset => Boolean(asset));
    setMode(job.operation);
    setReferenceAssets(references);
    setActiveAsset(job.operation === "generate" ? null : references[0] || null);
    setMaskAssetId(job.maskAssetId || undefined);
    setPreparedOutpaintAsset(job.operation === "outpaint" ? references[0] : undefined);
    setReuseJob({ ...job });
  };

  const handleMaxReferences = useCallback((maximum: number) => {
    setMaxReferences(maximum);
  }, []);

  return (
    <div className="flex min-h-full w-full flex-col bg-[#0a0a0a] md:h-full md:flex-row md:overflow-hidden">
      <div className="relative z-10 flex h-[560px] w-full flex-shrink-0 flex-col border-b border-border bg-card/50 md:h-full md:w-80 md:border-b-0 md:border-r">
        <GenerationPanel 
          activeAsset={activeAsset} 
          referenceAssets={referenceAssets}
          preparedOutpaintAsset={preparedOutpaintAsset}
          maskAssetId={maskAssetId}
          mode={mode} 
          setMode={changeMode} 
          onRemoveReference={removeReference}
          onMaxReferencesChange={handleMaxReferences}
          reuseJob={reuseJob}
          onUpload={openUpload}
          uploadedInput={uploadedInput}
        />
      </div>

      {/* Main Area: Preview & Gallery */}
      <div className="relative flex min-w-0 flex-none flex-col overflow-hidden md:flex-1">
        <div className="flex h-[420px] flex-none flex-col overflow-hidden p-2 md:h-auto md:min-h-0 md:flex-1 md:p-4">
          <ActiveImagePreview 
            asset={activeAsset} 
            onClear={clearAsset}
            mode={mode}
            onMaskUpdate={setMaskAssetId}
            onAssetUpdated={updateActiveAsset}
            onOutpaintPrepared={setPreparedOutpaintAsset}
            onUpload={openUpload}
          />
        </div>
        
        {/* Bottom Gallery */}
        <div className="h-64 flex-shrink-0 border-t border-border bg-black/40 backdrop-blur-sm">
          <ImageGallery 
            activeAssetId={activeAsset?.id} 
            selectedReferenceIds={referenceAssets.map((asset) => asset.id)}
            maxReferences={mode === "generate"
              ? maxReferences
              : Math.max(0, maxReferences - (activeAsset ? 1 : 0))}
            onSelect={selectAsset}
            onToggleReference={toggleReference}
            onReuseJob={reuseSettings}
            onUpload={openUpload}
            uploadedAssetId={uploadedInput?.id}
          />
        </div>
      </div>
      {uploadOpen && (
        <UploadImageDialog
          initialIntent={mode === "generate" ? "generate" : mode === "upscale" ? "upscale" : "edit"}
          onClose={() => setUploadOpen(false)}
          onUploaded={uploaded}
        />
      )}
    </div>
  );
}
