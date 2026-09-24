import { Link, useLocation } from "wouter";
import { ReactNode, useState, useEffect } from "react";
import {
  Clapperboard,
  Film,
  Users, 
  Map, 
  Activity, 
  Server, 
  Workflow, 
  Settings as SettingsIcon,
  Video,
  Menu,
  X,
  UserCircle,
  Palette,
  Coins
} from "lucide-react";
import { useHealthCheck, useGetSession } from "@workspace/api-client-react";
import { InstallAppPrompt } from "@/components/pwa/install-app-prompt";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const wordmarkSrc = `${import.meta.env.BASE_URL}brand/obtv-creator-ai-wordmark.png`;

  const { data: health } = useHealthCheck();
  const { data: session } = useGetSession();

  // Close mobile menu when location changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  const links = [
    { href: "/studio", label: "Generate Video", icon: Clapperboard },
    { href: "/image-studio", label: "Image Studio", icon: Palette },
    { href: "/reference-video", label: "Reference Video", icon: Video },
    { href: "/projects", label: "Long-Form", icon: Film },
    { href: "/characters", label: "Characters", icon: Users },
    { href: "/settings", label: "Settings", icon: Map },
    { href: "/generations", label: "Queue & History", icon: Activity },
  ];

  const adminLinks = [
    { href: "/servers", label: "GPU Servers", icon: Server },
    { href: "/workflows", label: "Workflows", icon: Workflow },
    { href: "/admin", label: "Admin", icon: SettingsIcon },
  ];

  const allLinks = session?.user.siteRole === "SITE_ADMIN"
    ? [...links, ...adminLinks, { href: "/spending", label: "Spending", icon: Coins }]
    : [...links, { href: "/spending", label: "Spending", icon: Coins }];

  const primaryMobileLinks = [
    { href: "/studio", label: "Generate", icon: Clapperboard },
    { href: "/image-studio", label: "Images", icon: Palette },
    { href: "/projects", label: "Long-Form", icon: Film },
    { href: "/generations", label: "Queue", icon: Activity },
  ];

  const secondaryMobileLinks = allLinks.filter(link => !primaryMobileLinks.find(pl => pl.href === link.href));
  const primaryDesktopLinks = allLinks.filter((link) => ["/studio", "/image-studio", "/generations"].includes(link.href));
  const secondaryDesktopLinks = allLinks.filter((link) => !primaryDesktopLinks.some((primary) => primary.href === link.href));

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background text-foreground selection:bg-primary/30 dark">
      {/* Desktop studio bar: compact gallery scopes with secondary tools grouped away. */}
      <header className="relative z-30 hidden h-[68px] shrink-0 items-center justify-between gap-5 border-b border-border/70 bg-background/90 px-5 backdrop-blur-xl md:flex lg:px-8">
        <Link href="/studio" className="flex w-[176px] shrink-0 items-center">
          <img
            src={wordmarkSrc}
            alt="OBTV CreatorAi"
            className="h-auto w-full max-w-[150px] object-contain"
          />
        </Link>
        <nav aria-label="Studio sections" className="flex min-w-0 flex-1 items-center justify-center gap-1">
          {primaryDesktopLinks.map((link) => {
            const isActive = location === link.href || (link.href !== "/studio" && location.startsWith(link.href));
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-secondary font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                }`}
              >
                <link.icon className={`size-4 ${isActive ? "text-primary" : ""}`} />
                {link.label}
              </Link>
            );
          })}
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
              <Menu className="size-4" /> More
            </summary>
            <div className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-border bg-card p-2 shadow-2xl">
              {secondaryDesktopLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${location === link.href || location.startsWith(`${link.href}/`) ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"}`}
                >
                  <link.icon className="size-4" />{link.label}
                </Link>
              ))}
              <div className="my-2 border-t border-border/70" />
              <InstallAppPrompt compact />
            </div>
          </details>
        </nav>
        <div className="flex w-[220px] shrink-0 items-center justify-end gap-4">
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={`size-2 rounded-full ${health?.status === "ok" ? "bg-emerald-500" : "bg-destructive animate-pulse"}`} />
            {health?.status === "ok" ? "Connected" : "API offline"}
          </span>
          <Link
            href="/account"
            className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
              location.startsWith("/account")
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            }`}
          >
            <UserCircle className={`size-[18px] shrink-0 ${location.startsWith("/account") ? "text-primary" : ""}`} />
            <span className="max-w-32 truncate">{session?.user.displayName || "Account"}</span>
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="mobile-shell-content relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {/* Mobile Header (minimal) */}
        <div className="md:hidden flex-none h-14 flex items-center justify-between px-4 bg-sidebar border-b border-border z-10 sticky top-0">
          <img
            src={wordmarkSrc}
            alt="OBTV"
            className="h-5 object-contain"
          />
          <Link href="/account" className="flex items-center gap-2">
            <div className="size-6 rounded-full bg-secondary flex items-center justify-center border border-border">
              <UserCircle className="size-4 text-foreground" />
            </div>
          </Link>
        </div>

        {/* Page Content */}
        <div className="flex-1 overflow-y-auto w-full h-full relative">
          {children}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-[65px] border-t border-border bg-card/95 backdrop-blur-md flex items-center justify-around z-40 px-2 pb-safe">
        {primaryMobileLinks.map(link => {
          const isActive = location === link.href || (link.href !== "/studio" && location.startsWith(link.href));
          return (
            <Link 
              key={link.href}
              href={link.href}
              className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${
                isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <link.icon className={`size-5 ${isActive ? "drop-shadow-[0_0_8px_rgba(255,31,98,0.5)]" : ""}`} />
              <span className="text-[10px] font-medium tracking-wide">{link.label}</span>
            </Link>
          );
        })}
        <button 
          onClick={() => setMobileMenuOpen(true)}
          className="flex flex-col items-center justify-center w-full h-full space-y-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Menu className="size-5" />
          <span className="text-[10px] font-medium tracking-wide">More</span>
        </button>
      </div>

      {/* Mobile Fullscreen Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-background/95 backdrop-blur-xl flex flex-col animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between p-4 border-b border-border/50">
            <h2 className="text-lg font-bold">Studio Menu</h2>
            <button 
              onClick={() => setMobileMenuOpen(false)}
              className="p-2 rounded-full bg-secondary/50 text-foreground hover:bg-secondary"
            >
              <X className="size-5" />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 py-6 space-y-6">
            <InstallAppPrompt />

            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 px-3">Primary</h3>
              {primaryMobileLinks.map((link) => {
                const isActive = location === link.href || (link.href !== "/studio" && location.startsWith(link.href));
                return (
                  <Link 
                    key={link.href} 
                    href={link.href}
                    className={`flex items-center gap-4 rounded-xl px-4 py-3 transition-all ${
                      isActive 
                        ? "bg-primary/10 text-primary font-semibold border border-primary/20" 
                        : "bg-card border border-border text-foreground hover:border-primary/50"
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${isActive ? "bg-primary/20" : "bg-secondary"}`}>
                      <link.icon className="size-5" />
                    </div>
                    <span className="text-base">{link.label}</span>
                  </Link>
                );
              })}
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 px-3">Studio Settings</h3>
              {secondaryMobileLinks.map((link) => {
                const isActive = location === link.href || (link.href !== "/studio" && location.startsWith(link.href));
                return (
                  <Link 
                    key={link.href} 
                    href={link.href}
                    className={`flex items-center gap-4 rounded-xl px-4 py-3 transition-all ${
                      isActive 
                        ? "bg-primary/10 text-primary font-semibold border border-primary/20" 
                        : "bg-card border border-border text-foreground hover:border-primary/50"
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${isActive ? "bg-primary/20" : "bg-secondary"}`}>
                      <link.icon className="size-5" />
                    </div>
                    <span className="text-base">{link.label}</span>
                  </Link>
                );
              })}
              
              <Link 
                href="/account"
                className={`flex items-center gap-4 rounded-xl px-4 py-3 transition-all mt-4 ${
                  location.startsWith("/account")
                    ? "bg-primary/10 text-primary font-semibold border border-primary/20" 
                    : "bg-card border border-border text-foreground hover:border-primary/50"
                }`}
              >
                <div className={`p-2 rounded-lg ${location.startsWith("/account") ? "bg-primary/20" : "bg-secondary"}`}>
                  <UserCircle className="size-5" />
                </div>
                <div className="flex flex-col">
                  <span className="text-base">Account & Workspace</span>
                  <span className="text-xs text-muted-foreground">{session?.activeTenant?.name || "Manage"}</span>
                </div>
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}