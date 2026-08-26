import { useEffect, useState } from "react";
import { Download, ExternalLink, Share } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type InstallPlatform = "ios" | "android" | "chrome" | "other";

function getPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  if (/Android/.test(userAgent)) return "android";
  if (/Chrome|CriOS/.test(userAgent) && !/Edg|OPR/.test(userAgent)) return "chrome";
  return "other";
}

export function InstallAppPrompt({ compact = false }: { compact?: boolean }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [platform, setPlatform] = useState<InstallPlatform>("other");
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    setPlatform(getPlatform());
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setIsInstalled(standalone);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsInstalled(true);
      setShowGuide(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  if (isInstalled) return null;

  const openInstallGuide = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      return;
    }
    setShowGuide((open) => !open);
  };

  const title = deferredPrompt ? "Install CreatorAi" : "Add CreatorAi to your device";
  const description = platform === "ios"
    ? "In Safari, tap Share, then Add to Home Screen."
    : platform === "android"
      ? "Open the browser menu and choose Install app or Add to Home screen."
      : platform === "chrome"
        ? "Use the install icon in Chrome’s address bar, or open the browser menu and choose Install CreatorAi."
        : "Use your browser’s install or Add to Home screen option.";

  return (
    <div className={compact ? "relative" : "rounded-xl border border-primary/20 bg-primary/5 p-4"}>
      <Button
        type="button"
        variant={compact ? "ghost" : "outline"}
        size={compact ? "sm" : "default"}
        className={compact ? "w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground" : "w-full justify-center border-primary/30 hover:bg-primary/10"}
        onClick={openInstallGuide}
        aria-expanded={showGuide}
      >
        <Download className="mr-2 size-4" />
        {deferredPrompt ? "Install CreatorAi" : "Add to Home Screen"}
      </Button>

      {showGuide && (
        <div className={compact ? "absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl" : "mt-3 rounded-lg bg-background/60 p-3 text-sm"}>
          <div className="flex items-start gap-3">
            {platform === "ios" ? <Share className="mt-0.5 size-4 shrink-0 text-primary" /> : <ExternalLink className="mt-0.5 size-4 shrink-0 text-primary" />}
            <div>
              <p className="font-semibold text-sm">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-2 h-8 w-full text-xs" onClick={() => setShowGuide(false)}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}