import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";

/** One paid-cloud confirmation look across image, video, story and render steps. Callers reset `checked` after each submission. */
export function PaidConfirm({ checked, onChange, children, testId, checkboxTestId, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testId: string; checkboxTestId: string; disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 p-2 text-xs text-amber-100" data-testid={testId}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} data-testid={checkboxTestId} />
      <span>{children}</span>
    </label>
  );
}
