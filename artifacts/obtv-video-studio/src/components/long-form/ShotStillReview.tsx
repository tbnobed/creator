import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Check, X, Trash2, Camera, Upload, AlertCircle, RefreshCw } from "lucide-react";
import { useAttachLongFormShotStill, useReviewLongFormShotStill, useClearLongFormShotStill } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetLongFormProjectQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AssetPicker } from "./AssetPicker";

export function ShotStillReview({ 

  project, 
  shot, 
  open, 
  onOpenChange 
}: { 
  project: any; 
  shot: any; 
  open: boolean; 
  onOpenChange: (o: boolean) => void 
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [assetId, setAssetId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  
  const attachStill = useAttachLongFormShotStill();
  const reviewStill = useReviewLongFormShotStill();
  const clearStill = useClearLongFormShotStill();

  const handleUpload = async () => {
    if (!file && !assetId) return;
    
    setIsUploading(true);
    try {
      let updatedProject;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/long-form-projects/${project.id}/shots/${shot.id}/still`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) throw new Error("Failed to upload image");
        const updatedShot = await res.json();
        updatedProject = { ...project, shots: project.shots.map((s: any) => s.id === updatedShot.id ? updatedShot : s) };
        queryClient.setQueryData(getGetLongFormProjectQueryKey(project.id), updatedProject);
      } else {
        const updatedShot = await attachStill.mutateAsync({ id: project.id, shotId: shot.id, data: { assetId } });
        updatedProject = { ...project, shots: project.shots.map((s: any) => s.id === updatedShot.id ? updatedShot : s) };
        queryClient.setQueryData(getGetLongFormProjectQueryKey(project.id), updatedProject);
      }
      toast({ title: "Still uploaded successfully" });
      setFile(null);
      setAssetId("");
    } catch (err: any) {
      toast({ title: "Failed to upload still", description: err.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleReview = (action: "approve" | "reject") => {
    reviewStill.mutate({ 
      id: project.id, 
      shotId: shot.id, 
      data: { action, revision: shot.still?.revision, note: reviewNote } 
    }, {
      onSuccess: (updatedShot) => {
        const updatedProject = { ...project, shots: project.shots.map((s: any) => s.id === updatedShot.id ? updatedShot : s) };
        queryClient.setQueryData(getGetLongFormProjectQueryKey(project.id), updatedProject);
        toast({ title: `Still ${action === "approve" ? "approved" : "rejected"}` });
        if (action === "approve") onOpenChange(false);
      },
      onError: (err: any) => toast({ title: "Failed to review still", description: err.message, variant: "destructive" }),
    });
  };

  const handleDelete = () => {
    if (!window.confirm("Remove this still frame?")) return;
    clearStill.mutate({ id: project.id, shotId: shot.id }, {
      onSuccess: (updatedShot) => {
        const updatedProject = { ...project, shots: project.shots.map((s: any) => s.id === updatedShot.id ? updatedShot : s) };
        queryClient.setQueryData(getGetLongFormProjectQueryKey(project.id), updatedProject);
        toast({ title: "Still removed" });
      },
      onError: (err: any) => toast({ title: "Failed to remove still", description: err.message, variant: "destructive" }),
    });
  };

  const still = shot.still;
  const hasStill = !!still?.assetUrl;
  const isApproved = still?.status === "APPROVED";
  const isRejected = still?.status === "REJECTED";
  const needsReview = still?.status === "PENDING";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Camera className="w-5 h-5 text-primary" /> Shot Still Frame
          </DialogTitle>
          <DialogDescription>
            Continuity is enabled. Provide an approved still frame to lock in the visual composition before rendering the video.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x border-b">
          <div className="p-6 md:w-1/2 flex flex-col gap-4">
            {hasStill ? (
              <div className="relative rounded-xl overflow-hidden border bg-black aspect-video flex items-center justify-center group">
                <img src={still.assetUrl} alt="Shot Still" className="max-w-full max-h-full object-contain" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <Button variant="destructive" size="sm" onClick={handleDelete} disabled={clearStill.isPending}>
                    <Trash2 className="w-4 h-4 mr-2" /> Remove Still
                  </Button>
                </div>
              </div>
            ) : (
              <div className="aspect-video rounded-xl border border-dashed bg-muted/20 flex flex-col items-center justify-center p-6 text-center">
                <Camera className="w-10 h-10 text-muted-foreground mb-3 opacity-50" />
                <p className="text-sm font-medium">No still frame provided</p>
                <p className="text-xs text-muted-foreground mt-1 mb-4">Generate one in Image Studio or upload a reference.</p>
                <Link href="/image-studio" className="mb-4">
                  <Button variant="outline" size="sm">Go to Image Studio</Button>
                </Link>
                <div className="w-full flex items-center gap-2">
                  <Input type="file" className="text-xs flex-1" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                  <span className="text-xs text-muted-foreground font-medium shrink-0">OR</span>
                  <div className="flex-1 min-w-0">
                    <AssetPicker
                      value={assetId}
                      onChange={(val) => setAssetId(val || "")}
                      triggerClassName="h-9 text-xs"
                      placeholder="Select Image Studio Asset"
                    />
                  </div>
                  <Button size="sm" onClick={handleUpload} disabled={(!file && !assetId) || isUploading || attachStill.isPending}>
                    {isUploading || attachStill.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            )}
            
            {hasStill && (
              <div className={`p-3 rounded-lg border flex items-start gap-3 ${
                isApproved ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500" :
                isRejected ? "bg-destructive/10 border-destructive/20 text-destructive" :
                "bg-amber-500/10 border-amber-500/20 text-amber-500"
              }`}>
                {isApproved ? <Check className="w-5 h-5 shrink-0 mt-0.5" /> : 
                 isRejected ? <X className="w-5 h-5 shrink-0 mt-0.5" /> :
                 <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />}
                <div>
                  <p className="text-sm font-semibold uppercase tracking-wider">
                    {still.status.replace("_", " ")}
                  </p>
                  {still.reviewNote && (
                    <p className="text-xs mt-1 opacity-80 italic">"{still.reviewNote}"</p>
                  )}
                  {needsReview && still.revision > 1 && (
                    <p className="text-xs mt-1 text-amber-500/80 font-medium">
                      Updated still or shot settings (revision {still.revision}). Review required.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
          
          <div className="p-6 md:w-1/2 bg-muted/10 space-y-4">
            <h3 className="font-semibold border-b pb-2">Shot Details</h3>
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Prompt</span>
                <p className="mt-1 line-clamp-3">{shot.prompt}</p>
              </div>
              {shot.cameraInstructions && (
                <div>
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Camera</span>
                  <p className="mt-1 line-clamp-2">{shot.cameraInstructions}</p>
                </div>
              )}
            </div>

            {hasStill && needsReview && (
              <div className="mt-6 pt-4 border-t space-y-3">
                <Textarea 
                  placeholder="Review notes (optional)..." 
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  className="resize-none h-20"
                />
                <div className="flex gap-2">
                  <Button 
                    className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white" 
                    onClick={() => handleReview("approve")}
                    disabled={reviewStill.isPending}
                    data-testid="button-approve-still"
                  >
                    <Check className="w-4 h-4 mr-2" /> Approve
                  </Button>
                  <Button 
                    variant="destructive" 
                    className="flex-1" 
                    onClick={() => handleReview("reject")}
                    disabled={reviewStill.isPending}
                    data-testid="button-reject-still"
                  >
                    <X className="w-4 h-4 mr-2" /> Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}