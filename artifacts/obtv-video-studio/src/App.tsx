import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { Shell } from '@/components/layout/shell';
import GeneratePage from '@/pages/generate';
import CharactersPage from '@/pages/characters';
import SettingsPage from '@/pages/settings';
import ServersPage from '@/pages/servers';
import WorkflowsPage from '@/pages/workflows';
import AdminPage from '@/pages/admin';
import GenerationsPage from '@/pages/generations';
import GenerationDetailPage from '@/pages/generation-detail';

import ProjectsPage from '@/pages/projects';
import ProjectDetailPage from '@/pages/projects/[id]';
import NewProjectPage from '@/pages/projects/new';

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
        <Switch>
          <Route path="/" component={GeneratePage} />
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
      </RoutedErrorBoundary>
    </Shell>
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