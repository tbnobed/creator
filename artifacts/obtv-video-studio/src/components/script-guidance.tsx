import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb } from "lucide-react";
import { analyzeScript, readinessScore } from "@/lib/prompt-guidance";

export function ScriptGuidance({ script, storyline }: { script: string; storyline?: string }) {
  const issues = useMemo(() => analyzeScript(script, storyline), [script, storyline]);
  const score = readinessScore(issues);
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.035] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Script & shot checker</h3>
          <p className="text-xs text-muted-foreground">Checks structure without changing your authored shot boundaries.</p>
        </div>
        <span className={score >= 80 ? "text-emerald-500" : score >= 55 ? "text-amber-500" : "text-destructive"}>{score}% ready</span>
      </div>
      <div className="space-y-2">
        {issues.length === 0 && <p className="flex gap-2 text-xs text-emerald-500"><CheckCircle2 className="size-3.5" /> Script is ready to plan.</p>}
        {issues.map((issue, index) => (
          <p key={`${issue.message}-${index}`} className={`flex gap-2 text-xs ${issue.level === "error" ? "text-destructive" : issue.level === "warning" ? "text-amber-500" : "text-muted-foreground"}`}>
            {issue.level === "tip" ? <Lightbulb className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}
            {issue.message}
          </p>
        ))}
      </div>
    </div>
  );
}