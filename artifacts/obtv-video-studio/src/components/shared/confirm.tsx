import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean };
type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Shared, accessible confirmation used instead of window.confirm across the studio. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(typeof o === "string" ? { title: o } : o);
  }), []);
  const settle = (v: boolean) => { resolver.current?.(v); resolver.current = null; setOpts(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!opts} onOpenChange={(open) => { if (!open) settle(false); }}>
        <AlertDialogContent data-testid="dialog-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-confirm-title">{opts?.title}</AlertDialogTitle>
            {opts?.description && <AlertDialogDescription>{opts.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-cancel" onClick={() => settle(false)}>{opts?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-accept" onClick={() => settle(true)}
              className={opts?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
              {opts?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx;
}
