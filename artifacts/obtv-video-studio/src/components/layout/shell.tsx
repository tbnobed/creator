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
  Menu,
  X
} from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";
import { InstallAppPrompt } from "@/components/pwa/install-app-prompt";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const wordmarkSrc = `${import.meta.env.BASE_URL}brand/obtv-creator-ai-wordmark.jpg`;

  const { data: health } = useHealthCheck();

  // Close mobile menu when location changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  const links = [
    { href: "/", label: "Generate", icon: Clapperboard },
    { href: "/projects", label: "Long-Form", icon: Film },
    { href: "/characters", label: "Characters", icon: Users },
    { href: "/settings", label: "Settings", icon: Map },
    { href: "/generations", label: "Queue & History", icon: Activity },
    { href: "/servers", label: "GPU Servers", icon: Server },
    { href: "/workflows", label: "Workflows", icon: Workflow },
    { href: "/admin", label: "Admin", icon: SettingsIcon },
  ];

  const primaryMobileLinks = [
    { href: "/", label: "Generate", icon: Clapperboard },
    { href: "/projects", label: "Long-Form", icon: Film },
    { href: "/generations", label: "Queue", icon: Activity },
  ];

  const secondaryMobileLinks = links.filter(link => !primaryMobileLinks.find(pl => pl.href === link.href));

  return (
    <div className="flex h-[100dvh] w-full bg-background overflow-hidden selection:bg-primary/30 text-foreground dark">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex w-64 border-r border-border bg-sidebar text-sidebar-foreground flex-col">
        <div className="h-20 flex items-center bg-black px-5 border-b border-black">
          <img
            src={wordmarkSrc}
            alt="OBTV CreatorAi"
            className="h-auto w-full max-w-[210px] object-contain"
          />
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {links.map((link) => {
            const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
            return (
              <Link 
                key={link.href} 
                href={link.href}
                className={`flex items-center gap-3 rounded-md border-l-[3px] px-3 py-2 transition-all ${
                  isActive 
                    ? "border-l-primary bg-[linear-gradient(90deg,rgba(255,31,98,0.12),rgba(139,43,226,0.05))] pl-[9px] text-white font-semibold" 
                    : "border-l-transparent text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                }`}
              >
                <link.icon className={`size-4 ${isActive ? "text-primary" : ""}`} />
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border/50 text-xs text-sidebar-foreground/50 space-y-3">
          <InstallAppPrompt compact />
          <div className="flex items-center gap-2">
            <div className={`size-2 rounded-full ${health?.status === "ok" ? "bg-emerald-500" : "bg-destructive animate-pulse"}`} />
            API: {health?.status === "ok" ? "Connected" : "Disconnected"}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="mobile-shell-content flex-1 flex flex-col h-[100dvh] overflow-hidden relative z-0 bg-background">
        {/* Mobile Header (minimal) */}
        <div className="md:hidden flex-none h-12 flex items-center justify-between px-4 bg-black border-b border-border z-10 sticky top-0">
          <img
            src={wordmarkSrc}
            alt="OBTV"
            className="h-5 object-contain"
          />
          <div className="flex items-center gap-2">
            <div className={`size-2 rounded-full ${health?.status === "ok" ? "bg-emerald-500" : "bg-destructive animate-pulse"}`} />
          </div>
        </div>

        {/* Page Content */}
        <div className="flex-1 overflow-y-auto w-full h-full relative">
          {children}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-[65px] border-t border-border bg-card/95 backdrop-blur-md flex items-center justify-around z-40 px-2 pb-safe">
        {primaryMobileLinks.map(link => {
          const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
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
                const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
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
                const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
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
          </div>
        </div>
      )}
    </div>
  );
}
