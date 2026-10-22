import { useState, type ReactNode } from "react";
import { Clipboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generationFacts, type GenerationFactSource } from "@/lib/generation-facts";

/** Shared player frame. Wrappers supply what shows before the video exists (progress, cancel, failure). */
export function GenerationPlayer({ job, pending }: { job: { id: string; title?: string | null; status: string; outputUrl?: string | null }; pending: ReactNode }) {
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-black">
      {job.status === "COMPLETED" && job.outputUrl ? (
        <video key={job.id} src={job.outputUrl} controls playsInline preload="metadata" className="h-full w-full object-contain"
          aria-label={`Generated video: ${job.title || "Untitled generation"}`} data-testid={`video-generation-output-${job.id}`} />
      ) : pending}
    </div>
  );
}

/** Prompt with copy, plus the compiled prompt when present. */
export function GenerationPrompt({ prompt, compiledPrompt }: { prompt?: string | null; compiledPrompt?: string | null }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  return (
    <div className="space-y-3">
      <section aria-labelledby="generation-prompt-heading" className="rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="generation-prompt-heading" className="text-sm font-semibold">Prompt</h3>
          <Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(prompt || ""); setCopy("copied"); } catch { setCopy("error"); } }} data-testid="button-copy-generation-prompt">
            <Clipboard className="size-4" /> {copy === "copied" ? "Copied" : "Copy prompt"}
          </Button>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" data-testid="text-generation-prompt">{prompt || "No prompt provided"}</p>
        {copy === "error" && <p className="mt-2 text-xs text-destructive" role="alert">Could not copy the prompt. Check clipboard permissions and try again.</p>}
      </section>
      {compiledPrompt && (
        <details className="rounded-lg border border-border/60 bg-card/30 p-4">
          <summary className="cursor-pointer text-sm font-medium">Compiled prompt</summary>
          <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{compiledPrompt}</p>
        </details>
      )}
    </div>
  );
}

/** Shared metadata panel. */
export function GenerationDetails({ job, title = "Generation details" }: { job: GenerationFactSource; title?: string }) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4" data-testid="panel-generation-details">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        {generationFacts(job).map((f) => (
          <div key={f.key} className="min-w-0">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="mt-0.5 break-words font-medium" data-testid={f.testId}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
