import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  quoteVideoUpscale, submitVideoUpscale, useGetSession,
  getGetGenerationQueryKey, getListGenerationsQueryKey, getListVideoLibraryQueryKey,
  type GenerationJob, type VideoUpscaleQuote,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";

export function isTopazVideo(job: Pick<GenerationJob, "providerModelId">) {
  return job.providerModelId === "fal-ai/topaz/upscale/video";
}

function errorMessage(error: unknown) {
  const data = (error as { data?: { error?: string } })?.data;
  return data?.error || (error instanceof Error ? error.message : "Topaz request failed. Please try again.");
}

export function TopazProvenance({ job }: { job: GenerationJob }) {
  if (!isTopazVideo(job)) return null;
  const source = job.providerTaskMetadata?.topaz as { sourceId?: string; sourceWidth?: number; sourceHeight?: number } | undefined;
  return <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
    <p>Topaz Proteus · Upscaled{source?.sourceWidth ? ` from ${source.sourceWidth} × ${source.sourceHeight}` : ""}, not native high-resolution generation.</p>
    <p className="mt-1">The original is preserved. Original audio and timing are retained; audio is encoded as AAC for MP4 compatibility.</p>
    {source?.sourceId && <Link className="mt-2 inline-block text-primary underline" href={`/generations/${source.sourceId}`}>View original video</Link>}
  </div>;
}

/** Provider-neutral: any completed generated video, including local GPU output. */
export function TopazUpscaleAction({ job }: { job: GenerationJob }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<"1080p" | "4k">("1080p");
  const [quote, setQuote] = useState<VideoUpscaleQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const submittingRef = useRef(false);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { data: session } = useGetSession();

  useEffect(() => {
    setQuote(null);
    setError(null);
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void quoteVideoUpscale(job.id, { targetResolution: target }, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setQuote(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, job.id, target, quoteAttempt]);

  async function confirm() {
    if (!quote || quote.sourceId !== job.id || quote.targetResolution !== target || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Persist BEFORE dispatch. Transport retries and reopen/reload reuse the same paid intent.
      const key = `topaz:${session?.user.id}:${session?.activeTenant?.id}:${job.id}:${quote.quoteToken}`;
      let requestId = sessionStorage.getItem(key);
      if (!requestId) {
        requestId = crypto.randomUUID();
        sessionStorage.setItem(key, requestId);
      }
      const child = await submitVideoUpscale(job.id, { targetResolution: target, quoteToken: quote.quoteToken, requestId });
      const unbilled = ["not-submitted", "rejected"].includes(String(child.providerTaskMetadata?.submissionOutcome));
      if (child.status === "FAILED" && unbilled) {
        sessionStorage.removeItem(key);
        setError(`${child.errorMessage || "The previous attempt failed before paid processing."} Review a new estimate before confirming another attempt.`);
        setQuote(null);
        return;
      }
      // A concurrent request may have been coalesced into an existing child.
      sessionStorage.setItem(key, child.id);
      queryClient.setQueryData(getGetGenerationQueryKey(child.id), child);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListVideoLibraryQueryKey() }),
        queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes("spending") }),
      ]);
      setOpen(false);
      navigate(`/generations/${child.id}`);
    } catch (cause) {
      setError(`${errorMessage(cause)} Retrying here reuses the same request; it does not start a second copy.`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (job.status !== "COMPLETED" || !job.outputUrl || !job.outputMimeType?.startsWith("video/")) return null;
  return <>
    <Button variant="outline" onClick={() => setOpen(true)} data-testid="button-topaz-upscale">
      <Sparkles className="size-4" /> Upscale with Topaz
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!submittingRef.current) setOpen(next); }}>
      <DialogContent className="max-w-lg" data-topaz-dialog data-testid="dialog-topaz-upscale">
        <DialogTitle>Upscale with Topaz</DialogTitle>
        <DialogDescription>Optional paid Cloud processing using Topaz Proteus. Works with local GPU and Cloud videos. Your original stays untouched.</DialogDescription>
        <label className="space-y-2 text-sm">
          <span className="font-medium">Delivery size</span>
          <select className="block w-full rounded-md border border-input bg-background px-3 py-2" value={target}
            disabled={submitting} onChange={(e) => { setQuote(null); setTarget(e.target.value as "1080p" | "4k"); }} data-testid="select-topaz-target">
            <option value="1080p">1080p — fit within 1920 × 1080</option>
            <option value="4k">4K — fit within 3840 × 2160</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">Portrait dimensions are rotated. Aspect ratio is preserved. No frame interpolation or automatic upscaling.</p>
        {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Measuring source and preparing estimate…</p>}
        {quote && <div className="space-y-2 rounded-md border border-border bg-muted/30 p-4 text-sm" data-testid="topaz-quote">
          <p><strong>{quote.sourceWidth} × {quote.sourceHeight}</strong> → <strong>{quote.targetWidth} × {quote.targetHeight}</strong></p>
          <p>{quote.durationSeconds.toFixed(2)} seconds · {Number(quote.fps.toFixed(3))} fps · {quote.hasAudio ? "Original audio retained (AAC)" : "No audio in source"}</p>
          <p className="text-base font-semibold">Estimated cost: ${quote.estimatedUsd.toFixed(2)} USD</p>
          <p className="text-xs text-muted-foreground">{quote.pricingNote}</p>
        </div>}
        <p className="text-xs text-muted-foreground">The result is a separate, downloadable video in your library. Upscaled output is not native higher-resolution generation. This processes the full clip; short comparison previews are not available yet.</p>
        {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={submitting} onClick={() => setOpen(false)}>Cancel</Button>
          {!quote && !loading && <Button variant="outline" onClick={() => setQuoteAttempt((n) => n + 1)}>Retry estimate</Button>}
          <Button disabled={!quote || loading || submitting} onClick={() => void confirm()} data-testid="button-confirm-topaz">
            {submitting ? <><Loader2 className="size-4 animate-spin" /> Submitting…</> : "Confirm paid upscale"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}