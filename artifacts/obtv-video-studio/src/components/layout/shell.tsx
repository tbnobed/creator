import { Link, useLocation } from "wouter";
import { ReactNode } from "react";
import {
  Clapperboard,
  Users, 
  Map, 
  Activity, 
  Server, 
  Workflow, 
  Settings as SettingsIcon 
} from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const wordmarkSrc = `${import.meta.env.BASE_URL}brand/obtv-creator-ai-wordmark.jpg`;

  const { data: health } = useHealthCheck();

  const links = [
    { href: "/", label: "Generate", icon: Clapperboard },
    { href: "/characters", label: "Characters", icon: Users },
    { href: "/settings", label: "Settings", icon: Map },
    { href: "/generations", label: "Queue & History", icon: Activity },
    { href: "/servers", label: "GPU Servers", icon: Server },
    { href: "/workflows", label: "Workflows", icon: Workflow },
    { href: "/admin", label: "Admin", icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden selection:bg-primary/30 text-foreground dark">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="h-20 flex items-center px-5 border-b border-sidebar-border/50">
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

        <div className="p-4 border-t border-sidebar-border/50 text-xs text-sidebar-foreground/50">
          <div className="flex items-center gap-2">
            <div className={`size-2 rounded-full ${health?.status === "ok" ? "bg-emerald-500" : "bg-destructive animate-pulse"}`} />
            API: {health?.status === "ok" ? "Connected" : "Disconnected"}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative z-0 bg-background">
        {/* subtle noise texture for the studio feel */}
        <div className="pointer-events-none fixed inset-0 opacity-[0.03] mix-blend-overlay z-50 bg-[url('https://grainy-gradients.vercel.app/noise.svg')]"></div>
        {children}
      </main>
    </div>
  );
}