import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useListReferenceVideos } from "@workspace/api-client-react";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileVideo, Loader2, RotateCcw, Upload, Video } from "lucide-react";

const MAX_REFERENCE_VIDEO_BYTES = 250 * 1024 * 1024;
const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm"];
const REFERENCE_VIDEO_STORAGE_KEY = "obtv.referenceVideo";

type StoredReferenceVideo = {
  storageKey: string;
  mediaUrl: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
};

function readStoredReferenceVideo(): StoredReferenceVideo | null {
  try {
    const raw = window.localStorage.getItem(REFERENCE_VIDEO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReferenceVideo>;
    if (
      typeof parsed.storageKey !== "string" ||
      typeof parsed.mediaUrl !== "string" ||
      typeof parsed.name !== "string"
    ) return null;
    return {
      storageKey: parsed.storageKey,
      mediaUrl: parsed.mediaUrl,
      name: parsed.name,
      mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : "video/mp4",
      size: typeof parsed.size === "number" ? parsed.size : 0,
      previewUrl: typeof parsed.previewUrl === "string" ? parsed.previewUrl : undefined,
    };
  } catch {
    return null;
  }
}

function withReferenceVideoKey(path: string, storageKey: string): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("referenceVideoKey", storageKey);
  return `${url.pathname}${url.search}${url.hash}`;
}

export default function ReferenceVideoPage() {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [storedVideo, setStoredVideo] = useState<StoredReferenceVideo | null>(() => readStoredReferenceVideo());
  const [uploadedKey, setUploadedKey] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get("referenceVideoKey") ?? readStoredReferenceVideo()?.storageKey ?? null
  ));
  const [uploadedMediaUrl, setUploadedMediaUrl] = useState<string | null>(() => (
    readStoredReferenceVideo()?.mediaUrl ?? null
  ));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const { data: savedReferenceVideos, isLoading: isLoadingSavedVideos } = useListReferenceVideos();
  const returnToParam = new URLSearchParams(window.location.search).get("returnTo");
  const returnTo = returnToParam?.startsWith("/") && !returnToParam.startsWith("//") ? returnToParam : "/";
  const activeVideoName = file?.name ?? storedVideo?.name ?? "Saved reference video";
  const activeVideoSize = file ? formatBytes(file.size) : storedVideo?.size ? formatBytes(storedVideo.size) : "Previously uploaded";
  const activeVideoType = file?.type === "video/webm" || storedVideo?.mimeType === "video/webm" ? "WebM" : "MP4";

  useEffect(() => {
    const queryKey = new URLSearchParams(window.location.search).get("referenceVideoKey");
    const saved = readStoredReferenceVideo();
    if (queryKey && saved?.storageKey === queryKey) {
      setStoredVideo(saved);
      setUploadedMediaUrl(saved.mediaUrl);
    }
  }, []);

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
    setStoredVideo(null);
    setUploadedKey(null);
    setUploadedMediaUrl(null);
    window.localStorage.removeItem(REFERENCE_VIDEO_STORAGE_KEY);
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
      const nextStoredVideo: StoredReferenceVideo = {
        storageKey: payload.storageKey,
        mediaUrl: payload.mediaUrl,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        previewUrl: undefined,
      };
      setStoredVideo(nextStoredVideo);
      window.localStorage.setItem(REFERENCE_VIDEO_STORAGE_KEY, JSON.stringify(nextStoredVideo));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Reference video upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const useInComposer = () => {
    if (!uploadedKey) return;
    setLocation(withReferenceVideoKey(returnTo, uploadedKey));
  };

  const clearVideo = () => {
    setFile(null);
    setStoredVideo(null);
    setUploadedKey(null);
    setUploadedMediaUrl(null);
    setError("");
    window.localStorage.removeItem(REFERENCE_VIDEO_STORAGE_KEY);
  };

  const useSavedVideo = (video: NonNullable<typeof savedReferenceVideos>["items"][number]) => {
    const nextStoredVideo: StoredReferenceVideo = {
      storageKey: video.storageKey,
      mediaUrl: video.mediaUrl,
      name: video.name,
      mimeType: video.mimeType,
      size: video.size,
      previewUrl: video.previewUrl,
    };
    setFile(null);
    setStoredVideo(nextStoredVideo);
    setUploadedKey(video.storageKey);
    setUploadedMediaUrl(video.mediaUrl);
    setError("");
    window.localStorage.setItem(REFERENCE_VIDEO_STORAGE_KEY, JSON.stringify(nextStoredVideo));
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

            {(file || uploadedKey) && (
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                <FileVideo className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{activeVideoName}</p>
                  <p className="text-xs text-muted-foreground">{activeVideoSize} · {activeVideoType}</p>
                </div>
                {uploadedKey ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" /> : <Button type="button" variant="ghost" size="sm" onClick={clearVideo}>Remove</Button>}
              </div>
            )}

            {(isLoadingSavedVideos || (savedReferenceVideos?.items.length ?? 0) > 0) && (
              <div className="space-y-3 border-t border-border/50 pt-5">
                <div>
                  <h3 className="text-sm font-semibold">Previously uploaded videos</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Choose an existing reference video instead of uploading it again.</p>
                </div>
                {isLoadingSavedVideos ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/30 p-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading saved videos...
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {savedReferenceVideos?.items.map((video) => {
                      const isSelected = uploadedKey === video.storageKey;
                      return (
                        <button
                          type="button"
                          key={video.storageKey}
                          onClick={() => useSavedVideo(video)}
                          className={`group overflow-hidden rounded-lg border text-left transition-colors ${isSelected ? "border-primary bg-primary/10" : "border-border/60 bg-background/30 hover:border-primary/60"}`}
                        >
                          <div className="aspect-video overflow-hidden bg-black">
                            <img
                              src={video.previewUrl}
                              alt=""
                              className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                            />
                          </div>
                          <div className="flex items-center gap-2 p-3">
                            <FileVideo className="size-4 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">{video.name}</span>
                            {isSelected && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
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
            {file || uploadedKey ? (
              <div className="overflow-hidden rounded-lg border border-border bg-black shadow-lg">
                <video
                  key={uploadedMediaUrl ?? previewUrl ?? activeVideoName}
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