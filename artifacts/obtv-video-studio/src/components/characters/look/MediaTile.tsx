import type { ReactNode } from "react";
import { AlertTriangle, ImageOff, Loader2 } from "lucide-react";
import type { OutfitMediaState } from "@/lib/wardrobe-adapters";

/** Image area with consistent ready / generating / failed / empty states. Optionally opens a viewer. */
export function MediaFrame({ src, state, alt, aspect = "aspect-[3/4]", fit = "cover", onOpen, openLabel, error, className = "" }: {
  src?: string; state: OutfitMediaState; alt: string; aspect?: string; fit?: "cover" | "contain"; onOpen?: () => void; openLabel?: string; error?: string; className?: string;
}) {
  const body = src && state === "READY"
    ? <img src={src} alt={alt} loading="lazy" className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"} transition-transform duration-300 group-hover:scale-[1.03]`} />
    : <span className="flex h-full w-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground" title={error}>
        {state === "PENDING" ? <><Loader2 className="h-5 w-5 animate-spin text-primary" /> Generating</> : state === "FAILED" ? <><AlertTriangle className="h-5 w-5 text-destructive" /> Failed</> : <ImageOff className="h-5 w-5 opacity-40" />}
      </span>;
  const cls = `group relative block w-full overflow-hidden rounded-lg bg-muted/40 ${aspect} ${className}`;
  return onOpen
    ? <button type="button" onClick={onOpen} aria-label={openLabel ?? `Open ${alt}`} className={`${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>{body}</button>
    : <div className={cls}>{body}</div>;
}

/**
 * Shared card for outfits and reference images. Library and production callers pass
 * their own optional slots (scene range, state change, approval, actions, editable fields).
 */
export function MediaTile({ media, title, badges, meta, error, actions, children, testId, className = "" }: {
  media?: ReactNode; title?: ReactNode; badges?: ReactNode; meta?: ReactNode; error?: string; actions?: ReactNode; children?: ReactNode; testId?: string; className?: string;
}) {
  return (
    <article className={`min-w-0 ${className}`} data-testid={testId}>
      {media}
      {(title || badges || actions) && (
        <div className="mt-1.5 flex min-h-5 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {title && <p className="truncate text-sm font-semibold">{title}</p>}
            {badges && <div className="mt-0.5 flex flex-wrap gap-1">{badges}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
      {error && <p role="alert" className="text-xs text-destructive" data-testid={testId ? `${testId}-error` : undefined}>{error}</p>}
      {children}
    </article>
  );
}
