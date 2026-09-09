import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useAcceptTenantInvitation, useGetAuthConfig, useLogin, useRegister } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "wouter";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { publishAuthChanged } from "@/lib/auth-events";

const emailSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Enter a valid email address")
  .max(320, "Email must be 320 characters or fewer");

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be 128 characters or fewer"),
});

const registrationSchema = loginSchema.extend({
  displayName: z.string().trim().min(1, "Display name is required").max(160, "Display name must be 160 characters or fewer"),
  confirmPassword: z.string(),
  bootstrapToken: z.string()
    .max(256, "Setup token must be 256 characters or fewer")
    .refine((value) => !value || value.length >= 32, "Setup token must be at least 32 characters")
    .optional(),
}).refine(({ password, confirmPassword }) => password === confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type LoginValues = z.infer<typeof loginSchema>;
type RegistrationValues = z.infer<typeof registrationSchema>;

function authErrorMessage(error: unknown, action: "sign in" | "create your account"): string {
  const status = typeof error === "object" && error && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
  const data = typeof error === "object" && error && "data" in error
    ? (error as { data?: unknown }).data
    : undefined;
  const detail = data && typeof data === "object"
    ? ["detail", "message", "error"].map((key) => (data as Record<string, unknown>)[key]).find((value) => typeof value === "string")
    : undefined;

  if (status === 401) return "The email or password is incorrect.";
  if (status === 409) return "An account with this email already exists.";
  if (status === 429) return "Too many attempts. Please wait a moment and try again.";
  if (status && status >= 400 && status < 500 && detail) return String(detail);
  return `Unable to ${action} right now. Please try again.`;
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  const wordmarkSrc = `${import.meta.env.BASE_URL}brand/obtv-creator-ai-wordmark.png`;
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div className="pointer-events-none absolute left-1/2 top-1/2 size-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[120px]" />
      <div className="relative z-10 w-full max-w-md">
        <Link href="/" className="mb-7 flex justify-center" data-testid="link-auth-home">
          <img src={wordmarkSrc} alt="OBTV CreatorAi" className="h-9 object-contain" data-testid="img-auth-wordmark" />
        </Link>
        {children}
      </div>
    </div>
  );
}

export function SignInPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const login = useLogin();
  const acceptInvitation = useAcceptTenantInvitation();
  const { data: authConfig } = useGetAuthConfig();
  const invitationToken = new URLSearchParams(window.location.search).get("invite") || undefined;
  const canCreateAccount = Boolean(
    invitationToken
    || authConfig?.registrationEnabled
    || authConfig?.bootstrapAvailable,
  );
  const signUpHref = invitationToken
    ? `/sign-up?invite=${encodeURIComponent(invitationToken)}`
    : "/sign-up";
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const submit = (values: LoginValues) => {
    login.mutate({ data: values }, {
      onSuccess: async () => {
        queryClient.clear();
        publishAuthChanged();
        if (invitationToken) {
          try {
            await acceptInvitation.mutateAsync({ data: { token: invitationToken } });
          } catch {
            return;
          }
        }
        setLocation("/studio");
      },
    });
  };

  return (
    <AuthLayout>
      <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>Sign in to access your studio</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="space-y-5" data-testid="form-sign-in">
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl><Input {...field} type="email" autoComplete="email" disabled={login.isPending} data-testid="input-sign-in-email" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl><Input {...field} type="password" autoComplete="current-password" disabled={login.isPending} data-testid="input-sign-in-password" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
               {(login.error || acceptInvitation.error) && <p className="text-sm text-destructive" role="alert" data-testid="error-sign-in">{acceptInvitation.error ? "Signed in, but this workspace invitation could not be accepted." : authErrorMessage(login.error, "sign in")}</p>}
               <Button type="submit" className="w-full" disabled={login.isPending || acceptInvitation.isPending} data-testid="button-sign-in-submit">
                 {login.isPending || acceptInvitation.isPending ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          </Form>
          {canCreateAccount && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              New to OBTV?{" "}
              <Link href={signUpHref} className="font-medium text-primary hover:text-primary/80" data-testid="link-sign-up">Create an account</Link>
            </p>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export function SignUpPage() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const register = useRegister();
  const { data: authConfig, isLoading: authConfigLoading } = useGetAuthConfig();
  const invitationToken = new URLSearchParams(window.location.search).get("invite") || undefined;
  const registrationAllowed = Boolean(
    invitationToken
    || authConfig?.registrationEnabled
    || authConfig?.bootstrapAvailable,
  );
  const signInHref = invitationToken
    ? `/sign-in?invite=${encodeURIComponent(invitationToken)}`
    : "/sign-in";
  const form = useForm<RegistrationValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: { email: "", password: "", displayName: "", confirmPassword: "", bootstrapToken: "" },
  });

  const submit = ({ email, password, displayName, bootstrapToken }: RegistrationValues) => {
    register.mutate({
      data: {
        email,
        password,
        displayName,
        invitationToken,
        bootstrapToken: bootstrapToken?.trim() || undefined,
      },
    }, {
      onSuccess: () => {
        queryClient.clear();
        publishAuthChanged();
        setLocation("/studio");
      },
    });
  };

  if (!invitationToken && authConfigLoading) {
    return (
      <AuthLayout>
        <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Checking registration settings…
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  if (!registrationAllowed) {
    return (
      <AuthLayout>
        <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Registration is closed</CardTitle>
            <CardDescription>Ask a workspace administrator for an invitation link.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/sign-in" data-testid="link-registration-disabled-sign-in">Sign In</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Card className="border-border bg-card/95 shadow-2xl backdrop-blur">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create your account</CardTitle>
          <CardDescription>Join the professional AI video studio</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="space-y-4" data-testid="form-sign-up">
              <FormField control={form.control} name="displayName" render={({ field }) => (
                <FormItem><FormLabel>Display name</FormLabel><FormControl><Input {...field} autoComplete="name" disabled={register.isPending} data-testid="input-sign-up-display-name" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem><FormLabel>Email</FormLabel><FormControl><Input {...field} type="email" autoComplete="email" disabled={register.isPending} data-testid="input-sign-up-email" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem><FormLabel>Password</FormLabel><FormControl><Input {...field} type="password" autoComplete="new-password" disabled={register.isPending} data-testid="input-sign-up-password" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="confirmPassword" render={({ field }) => (
                <FormItem><FormLabel>Confirm password</FormLabel><FormControl><Input {...field} type="password" autoComplete="new-password" disabled={register.isPending} data-testid="input-sign-up-confirm-password" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="bootstrapToken" render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial setup token <span className="font-normal text-muted-foreground">(first account only)</span></FormLabel>
                  <FormControl><Input {...field} type="password" autoComplete="off" disabled={register.isPending} data-testid="input-sign-up-bootstrap" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {register.error && <p className="text-sm text-destructive" role="alert" data-testid="error-sign-up">{authErrorMessage(register.error, "create your account")}</p>}
              <Button type="submit" className="w-full" disabled={register.isPending} data-testid="button-sign-up-submit">
                {register.isPending ? "Creating account…" : "Create Account"}
              </Button>
            </form>
          </Form>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
             <Link href={signInHref} className="font-medium text-primary hover:text-primary/80" data-testid="link-sign-in">Sign in</Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}