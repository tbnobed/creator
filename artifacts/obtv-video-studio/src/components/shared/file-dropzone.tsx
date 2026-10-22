import { useId, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { pickAccepted } from "@/lib/file-accept";

/**
 * Shared upload chooser: click or drop, keyboard reachable, with the tool's own file restrictions.
 * Domain checks (size, duration, frame) stay in each tool via `validate`.
 */
export function FileDropzone({ accept, multiple, disabled, onFiles, title, hint, icon, validate, compact, testId = "dropzone-upload", children }: {
  accept: string; multiple?: boolean; disabled?: boolean; onFiles: (files: File[]) => void; title: string; hint?: string;
  icon?: ReactNode; validate?: (file: File) => string | null; compact?: boolean; testId?: string; children?: ReactNode;
}) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = (list: FileList | null) => {
    const r = pickAccepted(list, accept, multiple);
    if (!r.ok) { if (r.error) setError(r.error); return; }
    const files = r.files;
    const problem = validate ? files.map(validate).find(Boolean) : null;
    if (problem) { setError(problem); return; }
    setError(null);
    onFiles(files);
  };
  return (
    <div>
      <label htmlFor={id}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) take(e.dataTransfer.files); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed text-center transition-colors focus-within:ring-2 focus-within:ring-primary ${compact ? "gap-1 px-3 py-4" : "gap-2 px-6 py-10"} ${dragging ? "border-primary bg-primary/15" : "border-primary/40 bg-primary/5 hover:border-primary hover:bg-primary/10"} ${disabled ? "pointer-events-none opacity-50" : ""}`}
        data-testid={testId}>
        {icon ?? <Upload className={`${compact ? "size-4" : "size-6"} text-primary`} />}
        <span className={`${compact ? "text-xs" : "text-sm"} font-semibold`}>{title}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        {children}
        <input id={id} type="file" accept={accept} multiple={multiple} disabled={disabled} className="sr-only" aria-label={title}
          onChange={(e) => { take(e.target.files); e.target.value = ""; }} data-testid={`${testId}-input`} />
      </label>
      {error && <p role="alert" className="mt-2 text-xs text-destructive" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  );
}
