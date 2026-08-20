import { useGetDashboardSummary, useHealthCheck } from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Card } from "@/components/ui/card";
import { Activity, ShieldCheck, HardDrive, Database, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function AdminPage() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: health, isLoading: isLoadingHealth } = useHealthCheck();

  return (
    <Page>
      <PageHeader 
        title="Studio Admin" 
        description="System health, integrations, and setup guidance."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatusCard 
          title="API Health" 
          value={health?.status === "ok" ? "Online" : "Offline"} 
          icon={Activity} 
          isLoading={isLoadingHealth}
          status={health?.status === "ok" ? "good" : "bad"}
        />
        <StatusCard 
          title="Compute Fleet" 
          value={`${summary?.onlineServerCount || 0} Nodes`} 
          icon={HardDrive} 
          isLoading={isLoadingSummary}
          status={(summary?.onlineServerCount || 0) > 0 ? "good" : "warning"}
        />
        <StatusCard 
          title="Active Jobs" 
          value={summary?.activeGenerationCount?.toString() || "0"} 
          icon={Network} 
          isLoading={isLoadingSummary}
          status="neutral"
        />
        <StatusCard 
          title="Database" 
          value="Connected" 
          icon={Database} 
          isLoading={false}
          status="good"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="p-6 border-border/50 bg-card/30 backdrop-blur-sm">
          <h3 className="font-semibold text-lg flex items-center gap-2 mb-4">
            <ShieldCheck className="size-5 text-primary" /> Setup Guidance
          </h3>
          <div className="space-y-6 text-sm">
            <div className="relative pl-6 border-l-2 border-primary/30 pb-4">
              <div className="absolute -left-[9px] top-0 size-4 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground">1</div>
              <h4 className="font-medium text-base text-foreground">Configure Compute</h4>
              <p className="text-muted-foreground mt-1">
                Go to the <strong className="text-foreground/80">GPU Servers</strong> tab and add at least one ComfyUI worker. 
                Ensure it's reachable via network and has required custom nodes installed.
              </p>
            </div>
            
            <div className="relative pl-6 border-l-2 border-primary/30 pb-4">
              <div className="absolute -left-[9px] top-0 size-4 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground">2</div>
              <h4 className="font-medium text-base text-foreground">Import Workflows</h4>
              <p className="text-muted-foreground mt-1">
                In the <strong className="text-foreground/80">Workflows</strong> tab, paste ComfyUI API JSON format templates. 
                Map inputs carefully so the Generate page knows where to inject prompts and image sizes.
              </p>
            </div>

            <div className="relative pl-6 pb-2 border-l-2 border-transparent">
              <div className="absolute -left-[9px] top-0 size-4 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground">3</div>
              <h4 className="font-medium text-base text-foreground">Populate Library</h4>
              <p className="text-muted-foreground mt-1">
                Build your creative library in <strong className="text-foreground/80">Characters</strong> and <strong className="text-foreground/80">Settings</strong>. 
                These become reusable assets for the production team.
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-6 border-border/50 bg-card/30 backdrop-blur-sm">
          <h3 className="font-semibold text-lg mb-4">System Information</h3>
          <dl className="space-y-4 text-sm">
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <dt className="text-muted-foreground">Studio Version</dt>
              <dd className="font-mono">v0.1.0-beta</dd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <dt className="text-muted-foreground">Total Characters</dt>
              <dd className="font-mono">{isLoadingSummary ? "..." : summary?.characterCount || 0}</dd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <dt className="text-muted-foreground">Total Settings</dt>
              <dd className="font-mono">{isLoadingSummary ? "..." : summary?.settingCount || 0}</dd>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-border/50">
              <dt className="text-muted-foreground">Total Generations</dt>
              <dd className="font-mono">{isLoadingSummary ? "..." : summary?.completedGenerationCount || 0}</dd>
            </div>
            <div className="flex justify-between items-center py-2">
              <dt className="text-muted-foreground">Object Storage</dt>
              <dd>
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Configured</Badge>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </Page>
  );
}

function StatusCard({ title, value, icon: Icon, isLoading, status }: { 
  title: string, value: string, icon: any, isLoading: boolean, status: "good" | "bad" | "warning" | "neutral"
}) {
  return (
    <Card className="p-5 border-border/50 bg-card/30 backdrop-blur-sm flex flex-col justify-between h-32">
      <div className="flex justify-between items-start">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        <Icon className={`size-5 ${
          status === "good" ? "text-emerald-500" :
          status === "bad" ? "text-destructive" :
          status === "warning" ? "text-amber-500" :
          "text-primary"
        }`} />
      </div>
      <div>
        {isLoading ? (
          <div className="h-8 w-24 bg-secondary/50 animate-pulse rounded" />
        ) : (
          <p className="text-2xl font-bold font-mono tracking-tight">{value}</p>
        )}
      </div>
    </Card>
  );
}