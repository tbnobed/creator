import { ModelOptionLabel } from "@/components/shared/model-option";
import { imageModelOption } from "@/lib/model-option";
import { PaidConfirm } from "@/components/shared/paid-confirm";
import { useEffect, useState } from "react";
import { useListImageStudioModels } from "@workspace/api-client-react";
import type { ImageModel } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ImageModelKey, ProductionSettings } from "@/lib/production-types";

export type ModelKind = "generate" | "edit";

export function unsupportedReason(m: ImageModel, kind: ModelKind): string | null {
  if (!m.available) return m.unavailableReason || "Unavailable right now";
  if (!m.operations.includes(kind)) return kind === "edit" ? "Does not support image editing" : "Does not support text-to-image";
  if (kind === "edit" && m.maxReferences < 1) return "Does not accept a reference image";
  return null;
}

/** Per-step model choice persisted in settings.imageModels; paid confirmation is local and resets. */
export function useModelChoice(stepKey: ImageModelKey, kind: ModelKind, settings: ProductionSettings, onSettings: (p: Partial<ProductionSettings>) => void) {
  const { data, isLoading, error } = useListImageStudioModels();
  const models = data?.models ?? [];
  const stored = settings.imageModels?.[stepKey];
  // Default only to a supported LOCAL model; never auto-pick a paid one.
  const fallback = models.find((m) => m.provider === "LOCAL" && !unsupportedReason(m, kind))?.id;
  const modelId = stored ?? fallback ?? "";
  const model = models.find((m) => m.id === modelId);
  const reason = model ? unsupportedReason(model, kind) : null;
  const paid = model?.provider === "CLOUD";
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [modelId]);

  const setModel = (id: string) => onSettings({ imageModels: { ...(settings.imageModels ?? {}), [stepKey]: id } });
  const canSubmit = !!model && !reason && (!paid || confirmed);
  const payload = () => ({ modelId, cloudConfirmed: paid ? confirmed : false });
  const reset = () => setConfirmed(false);

  return { models, isLoading, error, modelId, model, reason, paid, confirmed, setConfirmed, setModel, canSubmit, payload, reset, kind, stepKey };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;

export function ModelPicker({ choice, label = "Image model" }: { choice: ModelChoice; label?: string }) {
  const { models, isLoading, error, modelId, model, reason, paid, confirmed, setConfirmed, setModel, kind, stepKey } = choice;
  return (
    <div className="space-y-1.5" data-testid={`picker-model-${stepKey}`}>
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <Select value={modelId || undefined} onValueChange={setModel}>
        <SelectTrigger className="h-9" data-testid={`select-model-${stepKey}`}>
          <SelectValue placeholder={isLoading ? "Loading models" : "Choose a model"} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => {
            const why = unsupportedReason(m, kind);
            return (
              <SelectItem key={m.id} value={m.id} disabled={!!why} data-testid={`option-model-${stepKey}-${m.id}`}>
                <ModelOptionLabel option={imageModelOption(m, why)} />
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-destructive" data-testid={`text-model-error-${stepKey}`}>Could not load models.</p>
        : !isLoading && models.length > 0 && !modelId ? <p className="text-xs text-amber-300" data-testid={`text-model-none-${stepKey}`}>No local model supports this step. Choose one above.</p> : null}
      {reason && <p className="text-xs text-destructive" data-testid={`text-model-reason-${stepKey}`}>{reason}</p>}
      {paid && model && !reason && (
        <PaidConfirm checked={confirmed} onChange={setConfirmed} testId={`confirm-paid-${stepKey}`} checkboxTestId={`checkbox-paid-${stepKey}`}>
          I confirm this uses paid cloud credits ({model.name}{model.priceNote ? `, ${model.priceNote}` : ""}). Portrait and reference-sheet batches generate four images; other image actions generate one.
        </PaidConfirm>
      )}
    </div>
  );
}

/** Standalone tools (library locations, characters) keep per-step model choice in local state; never auto-paid. */
export function useStandaloneModelChoice(stepKey: ImageModelKey, kind: ModelKind) {
  const [settings, setSettings] = useState<ProductionSettings>({} as ProductionSettings);
  return useModelChoice(stepKey, kind, settings, (p) => setSettings((s) => ({ ...s, ...p })));
}
