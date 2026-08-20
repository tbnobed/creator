import { useEffect, useState } from "react";
import { 
  useListServers, 
  useCreateServer, 
  useUpdateServer, 
  useDeleteServer, 
  useTestServerConnection,
  useGetServerQueue,
  useGetServerConfiguration,
  getListServersQueryKey,
  getGetServerQueueQueryKey,
  getGetServerConfigurationQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Server, Trash2, Edit2, Activity, HardDrive, Network, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

export default function ServersPage() {
  const { data: servers, isLoading } = useListServers();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <Page>
      <PageHeader 
        title="Compute Fleet" 
        description="Manage connected ComfyUI workers and GPU resources."
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="size-4" />
                Add Worker
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Configure GPU Worker</DialogTitle>
              </DialogHeader>
              <ServerForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map(i => (
            <Card key={i} className="h-32 bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : servers?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Server className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">No compute nodes configured</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Add a ComfyUI server to start processing generation jobs.
          </p>
          <Button onClick={() => setIsCreateOpen(true)}>Add your first worker</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {servers?.map(server => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </Page>
  );
}

function ServerCard({ server }: { server: any }) {
  const [isEditing, setIsEditing] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const deleteMutation = useDeleteServer();
  const updateMutation = useUpdateServer();
  const testMutation = useTestServerConnection();

  const handleDelete = async () => {
    if (confirm("Remove this compute node? Running jobs may fail.")) {
      await deleteMutation.mutateAsync({ id: server.id });
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
    }
  };

  const handleToggleEnable = async () => {
    setActionError(null);
    try {
      await updateMutation.mutateAsync({
        id: server.id,
        data: {
          displayName: server.displayName,
          priority: server.priority,
          enabled: !server.enabled
        }
      });
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update this worker.");
    }
  };

  const handleTestConnection = async () => {
    setActionError(null);
    try {
      const result = await testMutation.mutateAsync({ id: server.id });
      setConnectionMessage(result.message);
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetServerQueueQueryKey(server.id) });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Connection test failed.");
    }
  };

  const isOnline = server.status === "ONLINE";

  const { data: queueData } = useGetServerQueue(server.id, {
    query: {
      enabled: isOnline,
      queryKey: getGetServerQueueQueryKey(server.id),
      refetchInterval: 10000
    }
  });

  return (
    <Card className={`p-5 flex flex-col md:flex-row gap-6 border-l-4 bg-card/30 backdrop-blur-sm ${
      isOnline ? "border-l-emerald-500" : "border-l-destructive/50"
    } ${!server.enabled && "opacity-70 grayscale-[0.5]"}`}>
      
      <div className="flex-1 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h3 className="font-bold text-lg font-mono">{server.displayName}</h3>
              {isOnline ? (
                <Badge className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/20 gap-1.5">
                  <Wifi className="size-3" /> Online
                </Badge>
              ) : (
                <Badge variant="destructive" className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-destructive/20 gap-1.5">
                  <WifiOff className="size-3" /> Offline
                </Badge>
              )}
              {!server.enabled && <Badge variant="outline">Disabled</Badge>}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
              <Network className="size-3" />
              {server.hostname}
            </div>
          </div>
          
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-border/50 text-xs"
              onClick={handleTestConnection}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? "Testing..." : "Test connection"}
            </Button>
            <Switch checked={server.enabled} onCheckedChange={handleToggleEnable} />
            <Dialog open={isEditing} onOpenChange={setIsEditing}>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="size-8 h-8 w-8">
                  <Edit2 className="size-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>Edit GPU Worker</DialogTitle>
                </DialogHeader>
                <ServerForm initialData={server} onSuccess={() => setIsEditing(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="outline" size="icon" className="size-8 h-8 w-8 text-destructive border-destructive/20 hover:bg-destructive/10" onClick={handleDelete}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {(connectionMessage || actionError) && (
          <p className={`text-sm ${actionError ? "text-destructive" : "text-emerald-500"}`}>
            {actionError ?? connectionMessage}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Hardware</span>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <HardDrive className="size-4 text-primary" />
              {server.gpuName || "Unknown GPU"}
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">VRAM</span>
            <div className="text-sm font-medium font-mono">
              {server.memoryUsedGb !== undefined && server.memoryUsedGb !== null && server.vramGb ? (
                <span className={server.memoryUsedGb / server.vramGb > 0.9 ? "text-destructive" : ""}>
                  {server.memoryUsedGb.toFixed(1)} / {server.vramGb} GB
                </span>
              ) : (
                <span>{server.vramGb ? `${server.vramGb} GB` : "Unknown"}</span>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Active Jobs</span>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Activity className={`size-4 ${server.activeJobCount > 0 ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
              {queueData ? queueData.queueRunning : server.activeJobCount} 
              <span className="text-muted-foreground ml-1">(+{(queueData ? queueData.queuePending : server.queueSize) || 0} queued)</span>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Workflows</span>
            <div className="text-sm font-medium">
              {server.supportedWorkflowCount} templates
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ServerForm({ initialData, onSuccess }: { initialData?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createMutation = useCreateServer();
  const updateMutation = useUpdateServer();
  const [testResult, setTestResult] = useState<{ connected: boolean, message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(initialData?.apiBaseUrl ?? "");
  const [websocketUrl, setWebsocketUrl] = useState(initialData?.websocketUrl ?? "");
  const {
    data: savedConfiguration,
    isLoading: isLoadingConfiguration,
    isError: configurationLoadFailed,
  } = useGetServerConfiguration(initialData?.id ?? "", {
    query: {
      queryKey: getGetServerConfigurationQueryKey(initialData?.id ?? ""),
      enabled: Boolean(initialData?.id),
    },
  });

  useEffect(() => {
    if (!savedConfiguration) return;
    setApiBaseUrl(savedConfiguration.apiBaseUrl);
    setWebsocketUrl(savedConfiguration.websocketUrl);
  }, [savedConfiguration]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    const formData = new FormData(e.currentTarget);
    
    const tagsStr = formData.get("tags") as string;
    const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(Boolean) : [];

    const data: any = {
      displayName: formData.get("displayName"),
      priority: parseInt(formData.get("priority") as string || "10"),
      maxConcurrentJobs: parseInt(formData.get("maxConcurrentJobs") as string || "1"),
      tags,
    };

    // Only include URLs if they were actually entered (don't overwrite with blank if editing)
    const apiBaseUrl = formData.get("apiBaseUrl") as string;
    const websocketUrl = formData.get("websocketUrl") as string;
    
    if (apiBaseUrl && apiBaseUrl !== "") data.apiBaseUrl = apiBaseUrl;

    try {
      if (websocketUrl && websocketUrl !== "") {
        const normalizedSocket = new URL(websocketUrl.trim());
        if (normalizedSocket.protocol === "http:") normalizedSocket.protocol = "ws:";
        if (normalizedSocket.protocol === "https:") normalizedSocket.protocol = "wss:";
        data.websocketUrl = normalizedSocket.toString();
      }
      if (initialData?.id) {
        await updateMutation.mutateAsync({ id: initialData.id, data });
      } else {
        if (!data.apiBaseUrl || !data.websocketUrl) {
          setFormError("API Base URL and WebSocket URL are required for new servers.");
          return;
        }
        const created = await createMutation.mutateAsync({ data });
        const connection = await testMutation.mutateAsync({ id: created.id });
        if (!connection.connected) {
          setTestResult(connection);
        }
      }
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
      onSuccess();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save this GPU worker.");
    }
  };

  const testMutation = useTestServerConnection();

  const handleTestConnection = async () => {
    if (!initialData?.id) {
      setTestResult({ connected: false, message: "Save server first to test." });
      return;
    }
    try {
      const result = await testMutation.mutateAsync({ id: initialData.id });
      setTestResult({ connected: result.connected, message: result.message });
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
    } catch (err: any) {
      setTestResult({ connected: false, message: err.message || "Test failed." });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="displayName">Display Name</Label>
        <Input id="displayName" name="displayName" required defaultValue={initialData?.displayName} className="bg-secondary/20" placeholder="e.g. RTX-4090-Worker-1" />
      </div>
      {formError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      )}
      
      <div className="space-y-2">
        <Label htmlFor="apiBaseUrl">
          ComfyUI API Base URL
          {initialData && <span className="text-muted-foreground font-normal ml-2">({isLoadingConfiguration ? "Loading saved value…" : "Saved value"})</span>}
        </Label>
        <Input 
          id="apiBaseUrl" 
          name="apiBaseUrl" 
          required={!initialData} 
          type="url"
          value={apiBaseUrl}
          onChange={(event) => setApiBaseUrl(event.target.value)}
          className="bg-secondary/20 font-mono text-xs" 
          placeholder="http://192.168.1.100:8188" 
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="websocketUrl">
          ComfyUI WebSocket URL
          {initialData && <span className="text-muted-foreground font-normal ml-2">({isLoadingConfiguration ? "Loading saved value…" : "Saved value"})</span>}
        </Label>
        <Input 
          id="websocketUrl" 
          name="websocketUrl" 
          required={!initialData} 
          type="text"
          value={websocketUrl}
          onChange={(event) => setWebsocketUrl(event.target.value)}
          className="bg-secondary/20 font-mono text-xs" 
          placeholder="ws://192.168.1.100:8188/ws" 
        />
      </div>
      {configurationLoadFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the saved connection details. You can still change the other worker settings.
        </p>
      )}

      {initialData && (
        <div className="grid grid-cols-2 gap-4 rounded-md border border-border/50 bg-secondary/10 p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Detected GPU</Label>
            <p className="text-sm font-medium">{initialData.gpuName || "Not detected yet"}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Detected VRAM</Label>
            <p className="text-sm font-medium font-mono">{initialData.vramGb ? `${initialData.vramGb} GB` : "Not detected yet"}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="priority">Priority (lower runs first)</Label>
          <Input id="priority" name="priority" type="number" required defaultValue={initialData?.priority || 10} className="bg-secondary/20" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxConcurrentJobs">Max Concurrent Jobs</Label>
          <Input id="maxConcurrentJobs" name="maxConcurrentJobs" type="number" required defaultValue={initialData?.maxConcurrentJobs || 1} className="bg-secondary/20" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tags">Capabilities Tags (comma separated)</Label>
        <Input id="tags" name="tags" defaultValue={initialData?.tags?.join(", ")} className="bg-secondary/20" placeholder="sdxl, video, faceid" />
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-border/50">
        <div className="flex items-center gap-3">
          <Button 
            type="button" 
            variant="outline" 
            size="sm"
            className="text-xs border-border/50"
            onClick={handleTestConnection}
            disabled={!initialData || testMutation.isPending}
          >
            {testMutation.isPending ? "Testing..." : "Test Connection"}
          </Button>
          {testResult && (
            <span className={`text-xs font-mono ${testResult.connected ? "text-emerald-500" : "text-destructive"}`}>
              {testResult.message}
            </span>
          )}
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : initialData ? "Save Config" : "Add Worker"}
        </Button>
      </div>
    </form>
  );
}