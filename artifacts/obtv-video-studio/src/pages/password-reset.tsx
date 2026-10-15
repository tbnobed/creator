import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRedeemPasswordReset, useRequestPasswordReset } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "wouter";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { publishAuthChanged } from "@/lib/auth-events";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { AuthLayout } from "@/pages/auth";

export function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Email is required").email("Enter a valid email address").max(320, "Email must be 320 characters or fewer"),
});

const resetSchema = z.object({
  password: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be 128 characters or fewer"),
  confirmPassword: z.string(),
}).refine(({ password, confirmPassword }) => password === confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Module-level capture survives StrictMode double mounts after the fragment has been stripped.
let capturedToken: string | null = null;

function readFragmentToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const token = new URLSearchParams(hash).get("token");
    if (token) capturedToken = token;
  }
  return capturedToken;
}

export function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const request = useRequestPasswordReset({
    mutation: { onSuccess: () => setSubmitted(true) },
  });
  const form = useForm<z.infer<typeof forgotSchema>>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: "" },
  });
  const status = errorStatus(request.error);
  const errorText = request.error
    ? status === 429 ? "Too many reset requests. Please wait a few minutes and try again."
    : status === 503 ? "Password reset email is not available right now. Contact your workspace administrator."
    : "Unable to send a reset request right now. Please try again."
    : null;

  return (
    <AuthLayout>
      <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <CardDescription>We will email you a link to choose a new password</CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <div className="space-y-5">
              <p className="rounded-md border border-primary/30 bg-primary/10 p-4 text-sm" role="status" data-testid="text-forgot-accepted">
                If an account exists for that email, a reset link is on its way. The link expires shortly, so use it soon.
              </p>
              <Button asChild className="w-full"><Link href="/sign-in" data-testid="link-forgot-back-sign-in">Back to Sign In</Link></Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit((v) => request.mutate({ data: { email: v.email } }))} className="space-y-5" data-testid="form-forgot-password">
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl><Input {...field} type="email" autoComplete="email" disabled={request.isPending} data-testid="input-forgot-email" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                {errorText && <p className="text-sm text-destructive" role="alert" data-testid="error-forgot-password">{errorText}</p>}
                <Button type="submit" className="w-full" disabled={request.isPending} data-testid="button-forgot-submit">
                  {request.isPending ? "Sending…" : "Send Reset Link"}
                </Button>
              </form>
            </Form>
          )}
          {!submitted && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Remembered it?{" "}
              <Link href="/sign-in" className="font-medium text-primary hover:text-primary/80" data-testid="link-forgot-sign-in">Sign in</Link>
            </p>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [token] = useState<string | null>(() => readFragmentToken());
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);

  const redeem = useRedeemPasswordReset({
    mutation: {
      onSuccess: () => {
        capturedToken = null;
        queryClient.clear();
        publishAuthChanged();
        form.reset();
        setDone(true);
      },
    },
  });
  const form = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const status = errorStatus(redeem.error);
  const linkInvalid = !token || !TOKEN_PATTERN.test(token) || status === 400 || status === 404 || status === 410;

  if (done) {
    return (
      <AuthLayout>
        <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Password updated</CardTitle>
            <CardDescription>All existing sessions were signed out. Sign in with your new password.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => setLocation("/sign-in")} data-testid="button-reset-go-sign-in">Sign In</Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  if (linkInvalid) {
    return (
      <AuthLayout>
        <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl" data-testid="text-reset-invalid">This link can't be used</CardTitle>
            <CardDescription>Reset links expire and work only once. Request a fresh one to continue.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild className="w-full"><Link href="/forgot-password" data-testid="link-reset-request-another">Request Another Link</Link></Button>
            <Button asChild variant="ghost" className="w-full"><Link href="/sign-in" data-testid="link-reset-invalid-sign-in">Back to Sign In</Link></Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  const errorText = redeem.error
    ? status === 429 ? "Too many attempts. Please wait a moment and try again."
    : status === 503 ? "Password reset is temporarily unavailable. Please try again later."
    : "Unable to reset your password right now. Please try again."
    : null;

  return (
    <AuthLayout>
      <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
          <CardDescription>12 to 128 characters. Other sessions will be signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => redeem.mutate({ data: { token, password: v.password } }))} className="space-y-5" data-testid="form-reset-password">
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl><Input {...field} type="password" autoComplete="new-password" disabled={redeem.isPending} data-testid="input-reset-password" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="confirmPassword" render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm new password</FormLabel>
                  <FormControl><Input {...field} type="password" autoComplete="new-password" disabled={redeem.isPending} data-testid="input-reset-confirm-password" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {errorText && <p className="text-sm text-destructive" role="alert" data-testid="error-reset-password">{errorText}</p>}
              <Button type="submit" className="w-full" disabled={redeem.isPending} data-testid="button-reset-submit">
                {redeem.isPending ? "Updating…" : "Update Password"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
