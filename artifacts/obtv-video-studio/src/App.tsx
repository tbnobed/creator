import { lazy, Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { Shell } from '@/components/layout/shell';

const GeneratePage = lazy(() => import('@/pages/generate'));
const ReferenceVideoPage = lazy(() => import('@/pages/reference-video'));
const CharactersPage = lazy(() => import('@/pages/characters'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const ServersPage = lazy(() => import('@/pages/servers'));
const WorkflowsPage = lazy(() => import('@/pages/workflows'));
const AdminPage = lazy(() => import('@/pages/admin'));
const GenerationsPage = lazy(() => import('@/pages/generations'));
const GenerationDetailPage = lazy(() => import('@/pages/generation-detail'));
const ProjectsPage = lazy(() => import('@/pages/projects'));
const ProjectDetailPage = lazy(() => import('@/pages/projects/[id]'));
const NewProjectPage = lazy(() => import('@/pages/projects/new'));
const NotFound = lazy(() => import('@/pages/not-found'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Suspense fallback={<PageLoading />}>
          <Switch>
            <Route path="/" component={GeneratePage} />
            <Route path="/reference-video" component={ReferenceVideoPage} />
            <Route path="/projects" component={ProjectsPage} />
            <Route path="/projects/new" component={NewProjectPage} />
            <Route path="/projects/:id" component={ProjectDetailPage} />
            <Route path="/characters" component={CharactersPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/generations" component={GenerationsPage} />
            <Route path="/generations/:id" component={GenerationDetailPage} />
            <Route path="/servers" component={ServersPage} />
            <Route path="/workflows" component={WorkflowsPage} />
            <Route path="/admin" component={AdminPage} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </RoutedErrorBoundary>
    </Shell>
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;