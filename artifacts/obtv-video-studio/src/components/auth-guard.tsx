import { ReactNode } from "react";
import { useGetSession, getGetSessionQueryKey } from "@workspace/api-client-react";
import { Redirect } from "wouter";

interface AuthGuardProps {
  children: ReactNode;
  requireSiteAdmin?: boolean;
}

export function AuthGuard({ children, requireSiteAdmin = false }: AuthGuardProps) {
  const { data: session, isLoading: sessionLoading, error } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      retry: (failureCount, queryError) => {
        const status = (queryError as { status?: number }).status;
        return status !== 401 && status !== 403 && failureCount < 1;
      },
    }
  });

  if (sessionLoading) {
    return <PageLoading />;
  }

  // Handle 401 or 403 or other errors from session fetch
  if (error || !session) {
    if ((error as any)?.status === 401) {
      return <Redirect to="/sign-in" />;
    }
    if ((error as any)?.status === 403) {
      return (
        <div className="flex h-[100dvh] w-full items-center justify-center bg-background">
          <div className="text-center p-6 bg-card rounded-lg border border-border shadow-lg">
            <h2 className="text-xl font-bold mb-2">Access Denied</h2>
            <p className="text-muted-foreground">You do not have access to this resource.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-background">
        <div className="text-center p-6 bg-card rounded-lg border border-border shadow-lg">
          <h2 className="text-xl font-bold mb-2">Failed to load session</h2>
          <p className="text-muted-foreground">Please refresh the page and try again.</p>
        </div>
      </div>
    );
  }

  if (requireSiteAdmin && session.user.siteRole !== "SITE_ADMIN") {
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-background">
        <div className="text-center p-6 bg-card rounded-lg border border-border shadow-lg">
          <h2 className="text-xl font-bold text-destructive mb-2">Access Denied</h2>
          <p className="text-muted-foreground">You must be a Site Admin to access this page.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function PageLoading() {
  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-background">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-label="Loading session" />
    </div>
  );
}
