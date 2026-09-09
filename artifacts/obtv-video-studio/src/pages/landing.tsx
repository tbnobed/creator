import { Link } from "wouter";
import { useGetAuthConfig } from "@workspace/api-client-react";

export default function LandingPage() {
  const wordmarkSrc = `${import.meta.env.BASE_URL}brand/obtv-creator-ai-wordmark.jpg`;
  const { data: authConfig } = useGetAuthConfig();
  const registrationAvailable = Boolean(
    authConfig?.registrationEnabled || authConfig?.bootstrapAvailable,
  );

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/30">
      <header className="h-20 flex items-center justify-between px-6 md:px-10 border-b border-border bg-black sticky top-0 z-50">
        <img
          src={wordmarkSrc}
          alt="OBTV CreatorAi"
          className="h-7 md:h-9 object-contain"
          data-testid="img-landing-wordmark"
        />
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-medium text-foreground hover:text-primary transition-colors hidden md:block" data-testid="link-header-sign-in">
            Sign In
          </Link>
          {registrationAvailable && (
            <Link href="/sign-up" className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm" data-testid="link-header-sign-up">
              Get Started
            </Link>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-20 relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
        
        <div className="max-w-4xl mx-auto text-center relative z-10 space-y-8">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-white">
            Professional AI Video <br className="hidden md:block" />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#8B2BE2]">
              Production Studio
            </span>
          </h1>
          
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
            The complete toolkit for creators and production teams. Maintain continuity, clone voices, and direct cinematic shots with precision.
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            {registrationAvailable && (
              <Link
                href="/sign-up"
                className="w-full sm:w-auto px-8 py-4 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-semibold text-lg transition-colors shadow-lg hover:shadow-primary/25"
                data-testid="link-hero-sign-up"
              >
                Start Creating
              </Link>
            )}
            <Link 
              href="/sign-in"
              className="w-full sm:w-auto px-8 py-4 bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-lg font-semibold text-lg transition-colors"
              data-testid="link-hero-sign-in"
            >
              Sign In to Workspace
            </Link>
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground bg-black">
        <p>&copy; {new Date().getFullYear()} OBTV. All rights reserved.</p>
      </footer>
    </div>
  );
}
