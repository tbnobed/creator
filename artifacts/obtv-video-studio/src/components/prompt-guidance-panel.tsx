import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Loader2, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { useCheckPrompt, usePolishPrompt, type PromptCheckResult, type PromptPolishResult } from "@workspace/api-client-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { analyzePrompt, buildPrompt, readinessScore, type PromptFields } from "@/lib/prompt-guidance";

type Props = {
  prompt: string;
  onPromptChange: (value: string) => void;
  cameraInstructions: string;
  onCameraChange: (value: string) => void;
  motionInstructions: string;
  onMotionChange: (value: string) => void;
  negativePrompt: string;
  onNegativeChange: (value: string) => void;
  generationMode: string;
  dialogue?: string;
  onDialogueChange?: (value: string) => void;
  continuityNote?: string;
  onContinuityChange?: (value: string) => void;
  shotKind?: "SHOT" | "B-ROLL";
  requiresReference?: boolean;
  hasReference?: boolean;
};

const emptyFields: PromptFields = { subject: "", action: "", composition: "", setting: "", lighting: "", style: "" };

export function PromptGuidancePanel(props: Props) {
  const [fields, setFields] = useState<PromptFields>(emptyFields);
  const [suggestion, setSuggestion] = useState<{
    result: PromptPolishResult;
    snapshot: string;
    selected: Record<keyof PromptPolishResult, boolean>;
  } | null>(null);
  const [aiReview, setAiReview] = useState<{ result: PromptCheckResult; snapshot: string } | null>(null);
  const [aiCheckError, setAiCheckError] = useState("");
  const polish = usePolishPrompt();
  const check = useCheckPrompt();
  const latestSnapshot = useRef("");
  const issues = useMemo(() => analyzePrompt({
    prompt: props.prompt,
    cameraInstructions: props.cameraInstructions,
    motionInstructions: props.motionInstructions,
    dialogue: props.dialogue,
    shotKind: props.shotKind,
    requiresReference: props.requiresReference,
    hasReference: props.hasReference,
  }), [props]);
  const score = readinessScore(issues);
  const currentSnapshot = JSON.stringify({
    prompt: props.prompt,
    cameraInstructions: props.cameraInstructions,
    motionInstructions: props.motionInstructions,
    negativePrompt: props.negativePrompt,
    dialogue: props.dialogue ?? "",
    continuityNote: props.continuityNote ?? "",
    generationMode: props.generationMode,
    shotKind: props.shotKind ?? "SHOT",
  });
  latestSnapshot.current = currentSnapshot;
  const suggestionIsStale = Boolean(suggestion && suggestion.snapshot !== currentSnapshot);

  const requestCheck = () => {
    if (!props.prompt.trim() || check.isPending) return;
    const snapshot = currentSnapshot;
    setAiCheckError("");
    check.mutate({
      data: {
        prompt: props.prompt,
        cameraInstructions: props.cameraInstructions,
        motionInstructions: props.motionInstructions,
        negativePrompt: props.negativePrompt,
        dialogue: props.dialogue,
        continuityNote: props.continuityNote,
        generationMode: props.generationMode || "txt2vid",
        shotKind: props.shotKind,
      },
    }, {
      onSuccess: result => {
        if (latestSnapshot.current === snapshot) setAiReview({ result, snapshot });
      },
      onError: error => {
        if (latestSnapshot.current === snapshot) {
          setAiCheckError(error instanceof Error ? error.message : "AI prompt check failed.");
        }
      },
    });
  };

  useEffect(() => {
    if (!props.prompt.trim()) {
      setAiReview(null);
      setAiCheckError("");
      return;
    }
    const timer = window.setTimeout(requestCheck, 900);
    return () => window.clearTimeout(timer);
  }, [currentSnapshot]);

  const updateField = (name: keyof PromptFields, value: string) => setFields(current => ({ ...current, [name]: value }));
  const assemble = () => {
    const built = buildPrompt(fields);
    if (built) props.onPromptChange(built);
  };
  const requestPolish = () => {
    const snapshot = currentSnapshot;
    polish.mutate({
      data: {
        prompt: props.prompt,
        cameraInstructions: props.cameraInstructions,
        motionInstructions: props.motionInstructions,
        negativePrompt: props.negativePrompt,
        dialogue: props.dialogue,
        continuityNote: props.continuityNote,
        generationMode: props.generationMode || "txt2vid",
        shotKind: props.shotKind,
      },
    }, {
      onSuccess: result => setSuggestion({
        result,
        snapshot,
        selected: {
          prompt: true,
          cameraInstructions: true,
          motionInstructions: true,
          negativePrompt: true,
          dialogue: props.shotKind !== "B-ROLL",
          continuityNote: true,
        },
      }),
    });
  };
  const acceptSuggestion = () => {
    if (!suggestion || suggestionIsStale) return;
    const { result, selected } = suggestion;
    if (selected.prompt) props.onPromptChange(result.prompt);
    if (selected.cameraInstructions) props.onCameraChange(result.cameraInstructions);
    if (selected.motionInstructions) props.onMotionChange(result.motionInstructions);
    if (selected.negativePrompt) props.onNegativeChange(result.negativePrompt);
    if (selected.dialogue) props.onDialogueChange?.(result.dialogue);
    if (selected.continuityNote) props.onContinuityChange?.(result.continuityNote);
    setSuggestion(null);
  };

  return (
    <Card className="overflow-hidden border-primary/25 bg-primary/[0.035]">
      <Accordion type="single" collapsible>
        <AccordionItem value="builder" className="border-0 px-4">
          <AccordionTrigger className="hover:no-underline">
            <span className="flex items-center gap-2"><Wand2 className="size-4 text-primary" /> Prompt Builder & Live AI Check</span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-xs text-muted-foreground">The AI reviews your current shot after you pause editing. Build from visual ingredients or keep writing directly in the main prompt.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ["subject", "Subject", "Who or what is the focus?"],
                ["action", "Action", "What happens in this shot?"],
                ["composition", "Composition", "Medium shot, close-up, wide..."],
                ["setting", "Setting details", "Location, time, background..."],
                ["lighting", "Lighting & mood", "Soft daylight, dramatic neon..."],
                ["style", "Visual style", "Cinematic realism, commercial..."],
              ] as const).map(([name, label, placeholder]) => (
                <div className="space-y-1.5" key={name}>
                  <Label className="text-xs">{label}</Label>
                  <Input value={fields[name]} onChange={event => updateField(name, event.target.value)} placeholder={placeholder} className="h-9 bg-background/40 text-sm" />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={assemble} disabled={!Object.values(fields).some(Boolean)}>
                <Wand2 className="mr-2 size-3.5" /> Build prompt
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setFields(emptyFields)}>
                <RotateCcw className="mr-2 size-3.5" /> Clear fields
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={requestPolish} disabled={!props.prompt.trim() || polish.isPending}>
                {polish.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Sparkles className="mr-2 size-3.5" />} Polish with AI
              </Button>
            </div>
            {polish.isError && <p className="text-xs text-destructive">{(polish.error as Error).message || "AI polish failed. Your prompt was not changed."}</p>}

            <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" /> AI live check</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {check.isPending ? "Reviewing the current draft..." : aiReview ? "Review complete for the current draft." : "Review starts automatically after you pause."}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={requestCheck} disabled={!props.prompt.trim() || check.isPending}>
                  {check.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Sparkles className="mr-2 size-3.5" />} Check now
                </Button>
              </div>
              {aiCheckError && <p className="text-xs text-destructive">{aiCheckError}</p>}
              {aiReview && (
                <div className="space-y-3 border-t border-border/50 pt-3">
                  <p className="text-xs leading-relaxed text-foreground/90">{aiReview.result.summary}</p>
                  {aiReview.result.strengths.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-500">What is working</p>
                      <ul className="space-y-1">
                        {aiReview.result.strengths.map((strength, index) => <li key={`${strength}-${index}`} className="flex gap-2 text-xs text-muted-foreground"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />{strength}</li>)}
                      </ul>
                    </div>
                  )}
                  {aiReview.result.issues.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-500">Needs attention</p>
                      {aiReview.result.issues.map((issue, index) => (
                        <div key={`${issue.message}-${index}`} className="rounded border border-border/60 bg-background/50 p-2">
                          <p className={`text-xs font-medium ${issue.severity === "error" ? "text-destructive" : issue.severity === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>
                            {issue.severity.toUpperCase()}: {issue.message}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">Fix: {issue.fix}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="flex gap-2 text-xs text-emerald-500"><CheckCircle2 className="size-3.5 shrink-0" /> AI found no meaningful conflicts in this draft.</p>
                  )}
                </div>
              )}
            </div>

            {suggestion && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-background/70 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">AI suggestion — review before accepting</p>
                  <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setSuggestion(null)}><X className="size-4" /></Button>
                </div>
                {suggestionIsStale && (
                  <p className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-500">
                    Your original fields changed after this suggestion was requested. Keep your edits or request a fresh suggestion.
                  </p>
                )}
                <div className="space-y-3">
                  {(Object.keys(suggestion.result) as Array<keyof PromptPolishResult>).map(key => (
                    <label key={key} className="block rounded border border-border/60 p-2">
                      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                        <input
                          type="checkbox"
                          checked={suggestion.selected[key]}
                          onChange={event => setSuggestion({
                            ...suggestion,
                            selected: { ...suggestion.selected, [key]: event.target.checked },
                          })}
                        />
                        Apply {key.replace(/([A-Z])/g, " $1").toLowerCase()}
                      </span>
                      <Textarea
                        value={suggestion.result[key]}
                        onChange={event => setSuggestion({
                          ...suggestion,
                          result: { ...suggestion.result, [key]: event.target.value },
                        })}
                        className={key === "prompt" ? "min-h-24 text-sm" : "min-h-16 text-xs"}
                      />
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={acceptSuggestion} disabled={suggestionIsStale}><CheckCircle2 className="mr-2 size-3.5" /> Apply selected fields</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setSuggestion(null)}>Keep original</Button>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">Prompt readiness</span>
                <span className={score >= 80 ? "text-emerald-500" : score >= 55 ? "text-amber-500" : "text-destructive"}>{score}%</span>
              </div>
              <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-all" style={{ width: `${score}%` }} /></div>
              <div className="space-y-2">
                {issues.length === 0 && <p className="flex gap-2 text-xs text-emerald-500"><CheckCircle2 className="size-3.5 shrink-0" /> Prompt is focused and ready.</p>}
                {issues.map((issue, index) => (
                  <p key={`${issue.message}-${index}`} className={`flex gap-2 text-xs ${issue.level === "error" ? "text-destructive" : issue.level === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>
                    {issue.level === "tip" ? <Lightbulb className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}
                    {issue.message}
                  </p>
                ))}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}