import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { lazy, Suspense, ReactNode, useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Shell } from "@/components/layout/shell";
import { AuthGuard } from "@/components/auth-guard";

const LandingPage = lazy(() => import("@/pages/landing"));
const GeneratePage = lazy(() => import("@/pages/generate"));
const ReferenceVideoPage = lazy(() => import("@/pages/reference-video"));
const CharactersPage = lazy(() => import("@/pages/characters"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const ServersPage = lazy(() => import("@/pages/servers"));
const WorkflowsPage = lazy(() => import("@/pages/workflows"));
const AdminPage = lazy(() => import("@/pages/admin"));
const GenerationsPage = lazy(() => import("@/pages/generations"));
const GenerationDetailPage = lazy(() => import("@/pages/generation-detail"));
const ProjectsPage = lazy(() => import("@/pages/projects"));
const ProjectDetailPage = lazy(() => import("@/pages/projects/[id]"));
const NewProjectPage = lazy(() => import("@/pages/projects/new"));
const AccountPage = lazy(() => import("@/pages/account"));
const NotFound = lazy(() => import("@/pages/not-found"));

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
);

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/brand/obtv-creator-ai-wordmark.jpg`,
  },
  variables: {
    colorPrimary: "hsl(342, 100%, 56%)",
    colorForeground: "hsl(0, 0%, 98%)",
    colorMutedForeground: "hsl(224, 12%, 57%)",
    colorDanger: "hsl(0, 85%, 60%)",
    colorBackground: "hsl(220, 17%, 9%)",
    colorInput: "hsl(219, 15%, 13%)",
    colorInputForeground: "hsl(0, 0%, 98%)",
    colorNeutral: "hsl(223, 16%, 18%)",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card border border-border rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-bold text-2xl",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground font-medium",
    formFieldLabel: "text-foreground font-medium",
    footerActionLink: "text-primary hover:text-primary/80 font-medium",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground bg-transparent px-2",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-emerald-500",
    alertText: "text-destructive-foreground",
    logoBox: "mb-6 flex justify-center",
    logoImage: "h-8 object-contain",
    socialButtonsBlockButton: "border border-border hover:bg-secondary/50 transition-colors bg-secondary text-foreground",
    formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground transition-colors font-medium border border-primary-border shadow-sm",
    formFieldInput: "bg-input border border-border text-foreground focus:ring-primary focus:border-primary placeholder:text-muted-foreground/50",
    footerAction: "bg-transparent",
    dividerLine: "bg-border",
    alert: "bg-destructive border-destructive border text-destructive-foreground",
    otpCodeFieldInput: "bg-input border border-border text-foreground focus:ring-primary focus:border-primary",
    formFieldRow: "mb-4",
    main: "w-full",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="relative z-10 w-full max-w-md">
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}/studio`} />
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="relative z-10 w-full max-w-md">
        <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/studio`} />
      </div>
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/studio" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function StudioRouter() {
  return (
    <AuthGuard>
      <Shell>
        <RoutedErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Switch>
              <Route path="/studio" component={GeneratePage} />
              <Route path="/reference-video" component={ReferenceVideoPage} />
              <Route path="/projects" component={ProjectsPage} />
              <Route path="/projects/new" component={NewProjectPage} />
              <Route path="/projects/:id" component={ProjectDetailPage} />
              <Route path="/characters" component={CharactersPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/generations" component={GenerationsPage} />
              <Route path="/generations/:id" component={GenerationDetailPage} />
              <Route path="/account" component={AccountPage} />
              <Route path="/servers">
                <AuthGuard requireSiteAdmin><ServersPage /></AuthGuard>
              </Route>
              <Route path="/workflows">
                <AuthGuard requireSiteAdmin><WorkflowsPage /></AuthGuard>
              </Route>
              <Route path="/admin">
                <AuthGuard requireSiteAdmin><AdminPage /></AuthGuard>
              </Route>
              <Route component={NotFound} />
            </Switch>
          </Suspense>
        </RoutedErrorBoundary>
      </Shell>
    </AuthGuard>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access your studio",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Join the professional AI video studio",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/studio" component={StudioRouter} />
            <Route path="/reference-video" component={StudioRouter} />
            <Route path="/projects" component={StudioRouter} />
            <Route path="/projects/new" component={StudioRouter} />
            <Route path="/projects/:id" component={StudioRouter} />
            <Route path="/characters" component={StudioRouter} />
            <Route path="/settings" component={StudioRouter} />
            <Route path="/generations" component={StudioRouter} />
            <Route path="/generations/:id" component={StudioRouter} />
            <Route path="/account" component={StudioRouter} />
            <Route path="/servers" component={StudioRouter} />
            <Route path="/workflows" component={StudioRouter} />
            <Route path="/admin" component={StudioRouter} />
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

function PageLoading() {
  return (
    <div className="flex min-h-full items-center justify-center bg-background">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-label="Loading page" />
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

export default App;
