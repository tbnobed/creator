import { useState } from "react";
import { useAdminPasswordReset } from "@workspace/api-client-react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function MemberPasswordReset({ email, displayName }: { email: string | null; displayName: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const reset = useAdminPasswordReset();
  const status = reset.error && typeof reset.error === "object" && "status" in reset.error
    ? Number(reset.error.status) : undefined;
  const error = reset.error ? status === 403 ? "Site-admin access and your correct current password are required."
    : status === 404 ? "This member does not have a password-enabled account."
    : status === 429 ? "Too many requests. Try again in 15 minutes."
    : status === 503 ? "The email could not be sent. Check the server's SendGrid settings."
    : "Unable to send the email. Please try again." : null;
  return <Dialog open={open} onOpenChange={value => {
    if (reset.isPending) return;
    setOpen(value); setPassword(""); reset.reset();
  }}>
    <DialogTrigger asChild>
      <Button variant="outline" size="sm" disabled={!email}
        aria-label={`Reset password for ${displayName}`}
        title={email ? `Email a password-reset link to ${displayName}` : "No email address on this account"}>
        <KeyRound className="size-3.5 mr-1.5" aria-hidden="true" />Reset password
      </Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reset password for {displayName}</DialogTitle>
        <DialogDescription>
          Send a single-use reset link to {email}. The member chooses their new password.
          Their sessions will be signed out when they complete the reset.
        </DialogDescription>
      </DialogHeader>
      {reset.isSuccess ? <div className="space-y-4">
        <p role="status" className="text-sm">Reset email accepted for delivery to {email}.</p>
        <Button onClick={() => { setOpen(false); reset.reset(); }}>Done</Button>
      </div> : <form className="space-y-4" onSubmit={event => {
        event.preventDefault();
        if (!email || !password || password.length > 128 || reset.isPending) return;
        reset.mutate({ data: { email, currentPassword: password } });
        setPassword("");
      }}>
        <div className="space-y-2">
          <Label htmlFor="member-reset-confirm-password">Your current administrator password</Label>
          <Input id="member-reset-confirm-password" type="password" autoComplete="current-password"
            value={password} maxLength={128} required disabled={reset.isPending}
            onChange={event => setPassword(event.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={reset.isPending} onClick={() => {
            setOpen(false); setPassword(""); reset.reset();
          }}>Cancel</Button>
          <Button type="submit" disabled={!password || !email || reset.isPending}>
            {reset.isPending ? "Sending…" : "Send reset email"}
          </Button>
        </DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>;
}
