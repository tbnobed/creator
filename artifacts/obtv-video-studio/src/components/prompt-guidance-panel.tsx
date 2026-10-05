import { useEffect, useMemo, useRef, useState, useId } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Loader2, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { useCheckPrompt, usePolishPrompt, checkPrompt, polishPrompt, type PromptCheckResult, type PromptPolishResult } from "@workspace/api-client-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const fieldPrefix = useId();
  const suggestionRef = useRef<HTMLDivElement>(null);
  const [polishNotice, setPolishNotice] = useState("");
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [fields, setFields] = useState<PromptFields>(emptyFields);
  const [builtDraft, setBuiltDraft] = useState<string | null>(null);
  const [appliedDraft, setAppliedDraft] = useState<{ fields: string; prompt: string } | null>(null);
  const [suggestion, setSuggestion] = useState<{
    result: PromptPolishResult;
    snapshot: string;
    selected: Record<keyof PromptPolishResult, boolean>;
  } | null>(null);
  const [aiReview, setAiReview] = useState<{ result: PromptCheckResult; snapshot: string } | null>(null);
  const [aiCheckError, setAiCheckError] = useState("");
  const [cooldown, setCooldown] = useState(false);
  const checkController = useRef<AbortController | null>(null);
  const polishController = useRef<AbortController | null>(null);
  const lastCheckSnapshot = useRef("");
  useEffect(() => () => {
    checkController.current?.abort();
    polishController.current?.abort();
  }, []);
  const errorMessage = (error: unknown) => {
    const failure = error as { status?: number; data?: { code?: string } };
    const suffix = " Your original prompt is unchanged.";
    if (failure?.status === 429) return "Local AI is busy or its request limit was reached. Wait before retrying." + suffix;
    if (failure?.status === 503) return "Local AI is not configured or unavailable. Check the prompt-ai service." + suffix;
    if (failure?.data?.code === "AI_INVALID_RESPONSE") return "Local AI returned an incomplete or invalid response. Check the API logs for AI_INVALID_RESPONSE." + suffix;
    if (failure?.data?.code === "AI_TIMEOUT") return "Local AI exceeded its three-minute processing limit. Check the prompt-ai service load." + suffix;
    if (failure?.status === 504 || failure?.status === 502 && !failure?.data?.code) return "The server or reverse proxy ended the AI request. Check API and proxy logs and their timeout settings." + suffix;
    return "The AI request failed. Check the API and prompt-ai logs for the cause." + suffix;
  };
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(false), 30000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const polish = usePolishPrompt({ mutation: { retry: false, mutationFn: ({ data }) => {
    polishController.current = new AbortController();
    return polishPrompt(data, { signal: AbortSignal.any([polishController.current.signal, AbortSignal.timeout(190000)]) });
  }, onError: error => { setCooldown(true); setPolishNotice(""); setAiCheckError(errorMessage(error)); } } });
  const check = useCheckPrompt({ mutation: { retry: false, mutationFn: ({ data }) => {
    checkController.current = new AbortController();
    return checkPrompt(data, { signal: AbortSignal.any([checkController.current.signal, AbortSignal.timeout(190000)]) });
  }, onError: error => { setCooldown(true); setAiCheckError(errorMessage(error)); } } });
  const disabledReason = !props.prompt.trim() ? "Write a main prompt first." : cooldown ? "AI is cooling down after an error. Try again in 30 seconds." : polish.isPending ? "Polishing your prompt. Local AI can take up to three minutes." : check.isPending ? "A prompt review is in progress. Local AI can take up to three minutes." : "";
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
  const score = props.prompt.trim() ? readinessScore(issues) : 0;
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
    if (!props.prompt.trim() || check.isPending || cooldown || polish.isPending) return;
    const snapshot = currentSnapshot;
    lastCheckSnapshot.current = snapshot;
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
          setAiCheckError(errorMessage(error));
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
    if (!liveEnabled || check.isPending || polish.isPending || cooldown || lastCheckSnapshot.current === currentSnapshot) return;
    const timer = window.setTimeout(requestCheck, 1800);
    return () => window.clearTimeout(timer);
  }, [currentSnapshot, liveEnabled, check.isPending, polish.isPending, cooldown]);

  const updateField = (name: keyof PromptFields, value: string) => setFields(current => ({ ...current, [name]: value }));
  const assemble = () => {
    const built = buildPrompt(fields);
    if (built) setBuiltDraft(built);
  };
  const applyBuiltDraft = (append: boolean) => {
    if (!builtDraft) return;
    const nextPrompt = append ? [props.prompt.trim(), builtDraft].filter(Boolean).join("\n\n") : builtDraft;
    setAppliedDraft({ fields: buildPrompt(fields) === builtDraft ? JSON.stringify(fields) : "", prompt: nextPrompt });
    props.onPromptChange(nextPrompt);
    setBuiltDraft(null);
  };
  const requestPolish = () => {
    if (cooldown || polish.isPending || check.isPending) return;
    setAiCheckError("");
    setPolishNotice("Polishing your prompt. Your original stays unchanged until you accept the suggestion.");
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
      onSuccess: result => {
        setPolishNotice("Polish complete. Review the suggestion below, then choose which changes to apply.");
        setSuggestion({
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
        });
        window.setTimeout(() => suggestionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
      },
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
    setPolishNotice("Selected changes applied to your prompt.");
  };

  return (
    <Card className="overflow-hidden border-primary/25 bg-primary/[0.035]">
      <Accordion type="single" collapsible>
        <AccordionItem value="builder" className="border-0 px-4">
          <AccordionTrigger className="hover:no-underline">
            <span className="flex items-center gap-2"><Wand2 className="size-4 text-primary" /> Prompt Builder & Live AI Check</span>
          </AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-sm text-muted-foreground">The main prompt is what gets rendered. These fields create a preview; they never replace your writing until you explicitly apply it.</p>
            <p className="h-12 text-sm" role="status">Builder readiness: {Object.values(fields).some(value => value.trim()) ? readinessScore(analyzePrompt({ prompt: buildPrompt(fields), cameraInstructions: props.cameraInstructions, motionInstructions: props.motionInstructions })) : 0}% · {appliedDraft?.fields === JSON.stringify(fields) && appliedDraft.prompt === props.prompt ? "Applied to main prompt" : appliedDraft ? "Changed since application" : "Not yet applied"}</p>
            <div className="grid gap-3">
              {([
                ["subject", "Subject", "Who or what is the focus?"],
                ["action", "Action", "What happens in this shot?"],
                ["composition", "Composition", "Medium shot, close-up, wide..."],
                ["setting", "Setting details", "Location, time, background..."],
                ["lighting", "Lighting & mood", "Soft daylight, dramatic neon..."],
                ["style", "Visual style", "Cinematic realism, commercial..."],
              ] as const).map(([name, label, placeholder]) => (
                <div className="space-y-1.5" key={name}>
                  <Label htmlFor={`${fieldPrefix}-${name}`} className="text-sm">{label}</Label>
                  <Textarea id={`${fieldPrefix}-${name}`} value={fields[name]} onChange={event => updateField(name, event.target.value)} placeholder={placeholder} className="h-16 min-h-16 resize-none bg-background/40 text-sm" />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={assemble} disabled={!Object.values(fields).some(value => value.trim())}>
                <Wand2 className="mr-2 size-3.5" /> Preview built prompt
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={!Object.values(fields).some(Boolean)} onClick={() => { setFields(emptyFields); setBuiltDraft(null); setAppliedDraft(null); }}>
                <RotateCcw className="mr-2 size-3.5" /> Clear fields
              </Button>
              <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={disabledReason || "Create a suggestion to review before applying."}><Button type="button" size="sm" variant="secondary" onClick={requestPolish} disabled={Boolean(disabledReason)}>
                {polish.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Sparkles className="mr-2 size-3.5" />} Polish with AI
              </Button></span></TooltipTrigger><TooltipContent className="z-[80] max-w-72">{disabledReason || "Create a suggestion to review before applying."}</TooltipContent></Tooltip>
            </div>
            {builtDraft && <div className="space-y-3 rounded-lg border border-border bg-background p-3">
              <p className="text-sm font-semibold">Built prompt preview</p>
              <p className="whitespace-pre-wrap text-sm">{builtDraft}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => applyBuiltDraft(false)}>Replace main prompt</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => applyBuiltDraft(true)}>Append to main prompt</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setBuiltDraft(null)}>Discard</Button>
              </div>
            </div>}
            <div role="status" className="text-sm text-muted-foreground">
              {aiCheckError || polishNotice || disabledReason}
            </div>

            <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" /> AI live check</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {check.isPending ? "Reviewing the current draft. Local AI may take up to three minutes…" : aiReview?.snapshot === currentSnapshot ? "Review complete for the current draft." : "Choose Check now, or enable automatic checking."}
                  </p>
                </div>
                <Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={disabledReason || "Review the main prompt"}><Button type="button" size="sm" variant="outline" onClick={requestCheck} disabled={Boolean(disabledReason)}>
                  {check.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Sparkles className="mr-2 size-3.5" />} Check now
                </Button></span></TooltipTrigger><TooltipContent className="z-[80] max-w-72">{disabledReason || "Review the main prompt"}</TooltipContent></Tooltip>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={liveEnabled} onChange={event => setLiveEnabled(event.target.checked)} /> Check automatically after typing</label>
              <p className="text-xs text-muted-foreground">Text review only: checks for contradictions in your instructions. It cannot predict lighting, timing, or prompt adherence in the generated video. Review the actual render before accepting it.</p>
              {aiReview && aiReview.snapshot === currentSnapshot && (
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
                    <p className="flex gap-2 text-xs text-emerald-500"><CheckCircle2 className="size-3.5 shrink-0" /> No text conflicts detected. Render accuracy has not been checked.</p>
                  )}
                </div>
              )}
            </div>

            {suggestion && (
              <div ref={suggestionRef} className="space-y-3 rounded-lg border border-primary/30 bg-background/70 p-3">
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