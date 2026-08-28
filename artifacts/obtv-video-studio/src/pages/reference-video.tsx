import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileVideo, Loader2, RotateCcw, Upload, Video } from "lucide-react";

const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;
const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm"];

export default function ReferenceVideoPage() {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [uploadedMediaUrl, setUploadedMediaUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const returnToParam = new URLSearchParams(window.location.search).get("returnTo");
  const returnTo = returnToParam?.startsWith("/") && !returnToParam.startsWith("//") ? returnToParam : "/";

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const selectFile = (nextFile: File | null) => {
    setError("");
    setUploadedKey(null);
    setUploadedMediaUrl(null);
    if (!nextFile) {
      setFile(null);
      return;
    }
    if (!ACCEPTED_VIDEO_TYPES.includes(nextFile.type)) {
      setFile(null);
      setError("Choose an MP4 or WebM reference video.");
      return;
    }
    if (nextFile.size > MAX_REFERENCE_VIDEO_BYTES) {
      setFile(null);
      setError("Reference videos must be 250 MB or smaller.");
      return;
    }
    setFile(nextFile);
  };

  const uploadVideo = async () => {
    if (!file || isUploading) return;
    setIsUploading(true);
    setError("");
    try {
      const response = await fetch("/api/reference-videos", {
        method: "POST",
        headers: {
          "content-type": file.type,
          "x-file-name": file.name,
        },
        body: file,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.storageKey !== "string" || typeof payload.mediaUrl !== "string") {
        throw new Error(payload.error || "Reference video upload failed.");
      }
      setUploadedKey(payload.storageKey);
      setUploadedMediaUrl(payload.mediaUrl);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Reference video upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const useInComposer = () => {
    if (!uploadedKey) return;
    const separator = returnTo.includes("?") ? "&" : "?";
    setLocation(`${returnTo}${separator}referenceVideoKey=${encodeURIComponent(uploadedKey)}`);
  };

  const clearVideo = () => {
    setFile(null);
    setUploadedKey(null);
    setUploadedMediaUrl(null);
    setError("");
  };

  return (
    <Page className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Reference Video"
        description="Upload presenter footage once, review it here, then send it into a reference-video workflow."
        actions={
          <Link href={returnTo}>
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="size-4" /> Back to Shot Composer
            </Button>
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <Card className="overflow-hidden border-border/60 bg-card/30">
          <div className="border-b border-border/50 bg-muted/10 p-5 md:p-7">
            <div className="flex items-start gap-4">
              <div className="rounded-xl bg-primary/15 p-3">
                <Video className="size-6 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Presenter reference footage</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Use an MP4 or WebM video when the selected workflow should follow a presenter’s movement, timing, and audio.
                  Characters and environments are optional for this workflow.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-5 p-5 md:p-7">
            <label
              htmlFor="reference-video-upload"
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-primary/40 bg-primary/5 px-6 py-12 text-center transition-colors hover:border-primary hover:bg-primary/10"
            >
              <div className="mb-4 rounded-full bg-primary/15 p-4">
                <Upload className="size-7 text-primary" />
              </div>
              <span className="text-base font-semibold">Choose a reference video</span>
              <span className="mt-2 text-xs text-muted-foreground">MP4 or WebM · maximum 250 MB</span>
              <input
                id="reference-video-upload"
                type="file"
                accept="video/mp4,video/webm"
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </label>

            {file && (
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                <FileVideo className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(file.size)} · {file.type === "video/webm" ? "WebM" : "MP4"}</p>
                </div>
                {uploadedKey ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" /> : <Button type="button" variant="ghost" size="sm" onClick={clearVideo}>Remove</Button>}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-border/50 pt-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={clearVideo} disabled={!file && !uploadedKey}>
                <RotateCcw className="mr-2 size-4" /> Choose Different Video
              </Button>
              <Button type="button" onClick={uploadVideo} disabled={!file || !!uploadedKey || isUploading} className="brand-glow">
                {isUploading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />}
                {isUploading ? "Uploading..." : uploadedKey ? "Uploaded" : "Upload Reference Video"}
              </Button>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden border-border/60 bg-card/30">
          <div className="border-b border-border/50 bg-muted/10 p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Video className="size-4 text-primary" /> Preview
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Review the footage before sending it to the composer.</p>
          </div>
          <div className="space-y-4 p-5">
            {file ? (
              <div className="overflow-hidden rounded-lg border border-border bg-black shadow-lg">
                <video
                  key={uploadedMediaUrl ?? previewUrl ?? file.name}
                  src={uploadedMediaUrl ?? previewUrl ?? undefined}
                  controls
                  playsInline
                  preload="metadata"
                  className="aspect-video w-full object-contain"
                />
              </div>
            ) : (
              <div className="flex aspect-video flex-col items-center justify-center rounded-lg border border-dashed border-border bg-black/30 text-center text-muted-foreground">
                <Video className="mb-3 size-8 opacity-40" />
                <p className="text-sm">Your video preview will appear here</p>
              </div>
            )}
            <div className="rounded-lg border border-border/50 bg-background/40 p-3 text-xs leading-relaxed text-muted-foreground">
              {uploadedKey
                ? <span className="flex items-center gap-2 text-emerald-500"><CheckCircle2 className="size-4 shrink-0" /> Uploaded and ready for the Shot Composer.</span>
                : "Upload the video to make it available to the generation workflow."}
            </div>
            <Button type="button" onClick={useInComposer} disabled={!uploadedKey} className="w-full">
              Use in Shot Composer <ArrowLeft className="ml-2 size-4 rotate-180" />
            </Button>
          </div>
        </Card>
      </div>
    </Page>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}