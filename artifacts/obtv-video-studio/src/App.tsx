import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { lazy, Suspense, ReactNode, useEffect } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { getGetSessionQueryKey, useGetSession } from "@workspace/api-client-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Shell } from "@/components/layout/shell";
import { AuthGuard } from "@/components/auth-guard";
import { SignInPage, SignUpPage } from "@/pages/auth";
import { subscribeToAuthChanges } from "@/lib/auth-events";

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
const ImageStudioPage = lazy(() => import("@/pages/image-studio"));
const ProjectsPage = lazy(() => import("@/pages/projects"));
const ProjectDetailPage = lazy(() => import("@/pages/projects/[id]"));
const NewProjectPage = lazy(() => import("@/pages/projects/new"));
const AccountPage = lazy(() => import("@/pages/account"));
const NotFound = lazy(() => import("@/pages/not-found"));

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function HomeRedirect() {
  const { data: session, isLoading, error, refetch, isFetching } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      retry: (failureCount, queryError) => (queryError as { status?: number }).status !== 401 && failureCount < 1,
    },
  });
  if (isLoading) return <PageLoading />;
  if (session) return <Redirect to="/studio" />;
  if ((error as { status?: number } | null)?.status === 401) return <LandingPage />;
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-lg">
        <h2 className="text-xl font-bold" data-testid="text-session-error">Unable to load OBTV</h2>
        <p className="mt-2 text-sm text-muted-foreground">Check your connection and try again.</p>
        <button className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-session">
          {isFetching ? "Retrying…" : "Try Again"}
        </button>
      </div>
    </div>
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
              <Route path="/image-studio" component={ImageStudioPage} />
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  return (
        <TooltipProvider>
          <AuthStateSynchronizer />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/studio" component={StudioRouter} />
            <Route path="/reference-video" component={StudioRouter} />
            <Route path="/projects" component={StudioRouter} />
            <Route path="/image-studio" component={StudioRouter} />
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
  );
}

function AuthStateSynchronizer() {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToAuthChanges(() => {
    queryClient.clear();
    window.location.reload();
  }), [queryClient]);
  return null;
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AppRoutes />
      </QueryClientProvider>
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
