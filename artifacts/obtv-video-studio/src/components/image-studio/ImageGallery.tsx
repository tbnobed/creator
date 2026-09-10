import { useDeferredValue, useEffect, useState } from "react";
import {
  ImageAsset,
  ImageJob,
  imageStudioError,
  useCancelJob,
  useDeleteJob,
  useGetAssets,
  useGetJobs,
} from "@/hooks/image-studio";
import {
  Copy,
  GitCompare,
  Heart,
  Image as ImageIcon,
  Loader2,
  Plus,
  Search,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ImageGalleryProps {
  activeAssetId?: string;
  selectedReferenceIds: string[];
  maxReferences: number;
  onSelect: (asset: ImageAsset) => void;
  onToggleReference: (asset: ImageAsset) => void;
  onReuseJob: (job: ImageJob, assets: ImageAsset[]) => void;
  onUpload: () => void;
  uploadedAssetId?: string;
}

export function ImageGallery({
  activeAssetId,
  selectedReferenceIds,
  maxReferences,
  onSelect,
  onToggleReference,
  onReuseJob,
  onUpload,
  uploadedAssetId,
}: ImageGalleryProps) {
  const [tab, setTab] = useState<"assets" | "jobs">("assets");
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [collection, setCollection] = useState("all");
  const deferredSearch = useDeferredValue(search);
  const { data: allAssetsData } = useGetAssets();
  const { data: assetsData, isLoading: assetsLoading } = useGetAssets({
    search: deferredSearch.trim() || undefined,
    favorite: favoritesOnly || undefined,
    collection: collection === "all" ? undefined : collection,
  });
  const assets = assetsData?.assets || [];
  const allAssets = allAssetsData?.assets || [];
  const collections = Array.from(new Set(allAssets.map((asset) => asset.collection).filter(Boolean))).sort();
  const { data: jobsData, isLoading: jobsLoading } = useGetJobs();
  const jobs = jobsData?.jobs || [];
  useEffect(() => {
    if (!uploadedAssetId) return;
    setTab("assets");
    setSearch("");
    setFavoritesOnly(false);
    setCollection("all");
  }, [uploadedAssetId]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex gap-4">
          <button className={`border-b-2 pb-1 text-sm font-medium ${tab === "assets" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={() => setTab("assets")}>
            Gallery
          </button>
          <button className={`border-b-2 pb-1 text-sm font-medium ${tab === "jobs" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={() => setTab("jobs")}>
            Queue & history
            {jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING") && <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />}
          </button>
        </div>
        {tab === "assets" && (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="relative hidden min-w-32 max-w-56 flex-1 sm:block">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search images" className="h-8 pl-7 text-xs" />
            </div>
            <select aria-label="Filter collection" value={collection} onChange={(event) => setCollection(event.target.value)} className="h-8 max-w-36 rounded-md border border-white/10 bg-black px-2 text-xs">
              <option value="all">All collections</option>
              {collections.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <Button variant={favoritesOnly ? "default" : "outline"} size="icon" aria-label="Favorites only" className="h-8 w-8" onClick={() => setFavoritesOnly((value) => !value)}>
              <Heart className={`h-3.5 w-3.5 ${favoritesOnly ? "fill-current" : ""}`} />
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onUpload}>
              <UploadCloud className="mr-1.5 h-3 w-3" />
              Upload
            </Button>
          </div>
        )}
      </div>

      {tab === "assets" && (
        <div className="px-3 pt-2 sm:hidden">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search images" className="h-8 text-xs" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
        {tab === "assets" && (
          <div className="flex h-full items-center gap-3 overflow-x-auto pb-1">
            {assetsLoading ? (
              <GalleryMessage><Loader2 className="h-6 w-6 animate-spin" />Loading…</GalleryMessage>
            ) : assets.length === 0 ? (
              <GalleryMessage><ImageIcon className="h-8 w-8 opacity-20" />No images match these filters.</GalleryMessage>
            ) : assets.map((asset) => {
              const selectedReference = selectedReferenceIds.includes(asset.id);
              const referenceLimitReached = !selectedReference && selectedReferenceIds.length >= maxReferences;
              return (
                <div
                  key={asset.id}
                  className={`group relative h-40 flex-shrink-0 overflow-hidden rounded-lg border-2 transition-all ${
                    activeAssetId === asset.id ? "border-primary shadow-[0_0_15px_rgba(255,31,98,0.4)]" : "border-transparent hover:border-white/20"
                  }`}
                  style={{ aspectRatio: `${asset.width}/${asset.height}` }}
                >
                  <button type="button" aria-label={`Select ${asset.name}`} onClick={() => onSelect(asset)} className="h-full w-full">
                    <img src={asset.url} alt={asset.name} className="h-full w-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 p-2 pt-6 text-left">
                      <p className="truncate text-[10px] font-medium text-white">{asset.name || "Untitled"}</p>
                      {asset.collection && <p className="truncate text-[9px] text-white/60">{asset.collection}</p>}
                    </div>
                  </button>
                  {asset.favorite && <Heart className="absolute left-2 top-2 h-3.5 w-3.5 fill-red-500 text-red-500 drop-shadow" />}
                  <Button
                    type="button"
                    size="icon"
                    variant={selectedReference ? "default" : "secondary"}
                    title={maxReferences === 0 ? "The selected model does not accept references" : selectedReference ? "Remove reference" : "Add reference"}
                    aria-label={selectedReference ? `Remove ${asset.name} as reference` : `Add ${asset.name} as reference`}
                    disabled={!selectedReference && (maxReferences === 0 || referenceLimitReached)}
                    className="absolute right-2 top-2 h-7 w-7"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleReference(asset);
                    }}
                  >
                    {selectedReference ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {tab === "jobs" && (
          <div className="flex h-full items-center gap-3 overflow-x-auto">
            {jobsLoading ? (
              <GalleryMessage><Loader2 className="h-6 w-6 animate-spin" />Loading queue…</GalleryMessage>
            ) : jobs.length === 0 ? (
              <GalleryMessage>Queue is empty.</GalleryMessage>
            ) : jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                references={job.referenceAssetIds.map((id) => allAssets.find((asset) => asset.id === id)).filter((asset): asset is ImageAsset => Boolean(asset))}
                onSelectAsset={onSelect}
                onReuse={() => onReuseJob(job, allAssets)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GalleryMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-muted-foreground">{children}</div>;
}

function JobCard({
  job,
  references,
  onSelectAsset,
  onReuse,
}: {
  job: ImageJob;
  references: ImageAsset[];
  onSelectAsset: (asset: ImageAsset) => void;
  onReuse: () => void;
}) {
  const cancelJob = useCancelJob();
  const deleteJob = useDeleteJob();
  const { toast } = useToast();
  const [compareOpen, setCompareOpen] = useState(false);
  const active = job.status === "QUEUED" || job.status === "RUNNING";
  const before = references[0];
  const after = job.assets[0];

  const cancel = async () => {
    try {
      await cancelJob.mutateAsync({ id: job.id });
      toast({ title: "Cancellation requested" });
    } catch (error) {
      toast({ title: "Could not cancel job", description: imageStudioError(error), variant: "destructive" });
    }
  };
  const remove = async () => {
    try {
      await deleteJob.mutateAsync({ id: job.id });
      toast({ title: "Job deleted" });
    } catch (error) {
      toast({ title: "Could not delete job", description: imageStudioError(error), variant: "destructive" });
    }
  };

  return (
    <>
      <div className="group relative flex h-full w-64 flex-shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card/80">
        <div className="relative flex flex-1 items-center justify-center bg-black/60">
          {job.status === "COMPLETED" && job.assets.length ? (
            <div className="grid h-full w-full grid-cols-2 gap-1 p-1">
              {job.assets.slice(0, 4).map((asset) => (
                <button key={asset.id} onClick={() => onSelectAsset(asset)} className="overflow-hidden rounded-sm">
                  <img src={asset.url} alt={asset.name} className="h-full w-full object-cover transition-opacity hover:opacity-80" />
                </button>
              ))}
            </div>
          ) : job.status === "FAILED" || job.status === "CANCELLED" ? (
            <div className="flex flex-col items-center p-4 text-center text-muted-foreground">
              <X className="mb-2 h-8 w-8 text-destructive" />
              <span className="text-xs">{job.status}</span>
              {job.errorMessage && <span className="mt-1 line-clamp-2 text-[9px]">{imageStudioError({ message: job.errorMessage })}</span>}
            </div>
          ) : (
            <div className="flex flex-col items-center p-4 text-center text-primary">
              <Loader2 className="mb-2 h-8 w-8 animate-spin" />
              <span className="text-xs">Processing…</span>
            </div>
          )}
          <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-black/70 p-1 backdrop-blur">
            {active ? (
              <Button variant="destructive" size="sm" className="h-7 text-[10px]" onClick={() => void cancel()} disabled={cancelJob.isPending}>Cancel</Button>
            ) : (
              <Button variant="ghost" size="icon" aria-label="Delete job" className="h-7 w-7 hover:bg-destructive" onClick={() => void remove()} disabled={deleteJob.isPending}><Trash2 className="h-3.5 w-3.5" /></Button>
            )}
          </div>
        </div>
        <div className="space-y-1 border-t border-border/50 bg-black/40 p-3">
          <div className="flex justify-between gap-2">
            <span className="truncate text-xs font-semibold capitalize text-primary">{job.operation}</span>
            <span className="whitespace-nowrap text-[9px] text-muted-foreground">{formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}</span>
          </div>
          <p className="line-clamp-1 text-[10px] text-muted-foreground">{job.prompt || "No prompt"}</p>
          <p className="truncate text-[9px] text-muted-foreground">{job.modelName} · {job.width}×{job.height} · {job.count}</p>
          <div className="flex gap-1 pt-1">
            <Button variant="outline" size="sm" className="h-7 flex-1 text-[10px]" onClick={onReuse}><Copy className="mr-1 h-3 w-3" />Reuse settings</Button>
            {before && after && (
              <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Compare before and after" onClick={() => setCompareOpen(true)}><GitCompare className="h-3 w-3" /></Button>
            )}
          </div>
        </div>
      </div>
      {before && after && <BeforeAfterDialog open={compareOpen} onOpenChange={setCompareOpen} before={before} after={after} />}
    </>
  );
}

function BeforeAfterDialog({
  open,
  onOpenChange,
  before,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  before: ImageAsset;
  after: ImageAsset;
}) {
  const [position, setPosition] = useState(50);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader><DialogTitle>Before / after</DialogTitle></DialogHeader>
        <div className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${after.width}/${after.height}` }}>
          <img src={after.url} alt={`After: ${after.name}`} className="absolute inset-0 h-full w-full object-contain" />
          <img
            src={before.url}
            alt={`Before: ${before.name}`}
            className="absolute inset-0 h-full w-full object-contain"
            style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          />
          <div className="absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position}%` }} />
          <input
            type="range"
            min={0}
            max={100}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
            aria-label="Before and after split"
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
          />
          <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs">Before</span>
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-xs">After</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}