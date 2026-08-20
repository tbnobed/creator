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
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border/50">
          <div className="flex items-center gap-2 text-primary font-bold text-lg tracking-tight">
            <div className="size-6 rounded-sm bg-primary flex items-center justify-center">
              <Clapperboard className="size-4 text-primary-foreground" />
            </div>
            OBTV STUDIO
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {links.map((link) => {
            const isActive = location === link.href || (link.href !== "/" && location.startsWith(link.href));
            return (
              <Link 
                key={link.href} 
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                  isActive 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
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