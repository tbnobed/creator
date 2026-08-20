import { useState } from "react";
import { 
  useListWorkflows, 
  useCreateWorkflow, 
  useUpdateWorkflow, 
  useGetWorkflow,
  getListWorkflowsQueryKey,
  getGetWorkflowQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Workflow, Code, Save, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function WorkflowsPage() {
  const { data: workflows, isLoading } = useListWorkflows();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <Page>
      <PageHeader 
        title="Workflow Templates" 
        description="Admin area. Import and map ComfyUI API JSON workflows."
        actions={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="size-4" />
                Import API JSON
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Import Workflow Template</DialogTitle>
              </DialogHeader>
              <WorkflowForm onSuccess={() => setIsCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      <div className="bg-primary/10 border border-primary/20 text-primary-foreground p-4 rounded-lg mb-6 flex gap-4 items-start">
        <TerminalSquare className="size-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-sm space-y-2">
          <p className="font-semibold text-primary">How mappings work</p>
          <p>This system acts as a bridge. It takes user input (prompts, dimensions) and maps it to specific node inputs in your ComfyUI API JSON.</p>
          <p><strong>Rules:</strong> You must supply a valid API format JSON (not the visual graph JSON). You must map known variables (e.g., <code className="bg-background/50 px-1 py-0.5 rounded text-primary">positive_prompt</code>) to exact <code className="bg-background/50 px-1 py-0.5 rounded text-primary">nodeId</code> and <code className="bg-background/50 px-1 py-0.5 rounded text-primary">input</code> names that exist in that JSON. Never invent node IDs.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map(i => (
            <Card key={i} className="h-32 bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : workflows?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Workflow className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">No workflows imported</h3>
          <Button onClick={() => setIsCreateOpen(true)} className="mt-4">Import API JSON</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {workflows?.map(wf => (
            <WorkflowCard key={wf.id} workflow={wf} />
          ))}
        </div>
      )}
    </Page>
  );
}

function WorkflowCard({ workflow }: { workflow: any }) {
  const [showJson, setShowJson] = useState(false);
  const queryClient = useQueryClient();
  const updateMutation = useUpdateWorkflow();

  const { data: fullWorkflow, isLoading } = useGetWorkflow(workflow.id, {
    query: { enabled: showJson, queryKey: getGetWorkflowQueryKey(workflow.id) }
  });

  const toggleActive = async () => {
    await updateMutation.mutateAsync({
      id: workflow.id,
      data: { active: !workflow.active }
    });
    queryClient.invalidateQueries({ queryKey: getListWorkflowsQueryKey() });
  };

  return (
    <Card className={`p-5 flex flex-col gap-4 border-l-4 bg-card/30 backdrop-blur-sm ${workflow.active ? "border-l-primary" : "border-l-muted opacity-60"}`}>
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h3 className="font-bold text-lg">{workflow.name}</h3>
            <Badge variant="outline" className="font-mono text-xs">v{workflow.version}</Badge>
            {!workflow.active && <Badge variant="secondary">Inactive</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{workflow.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground cursor-pointer" htmlFor={`active-${workflow.id}`}>
            {workflow.active ? "Active" : "Inactive"}
          </Label>
          <Switch id={`active-${workflow.id}`} checked={workflow.active} onCheckedChange={toggleActive} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-2">
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block">Mode</span>
          <span className="font-medium">{workflow.generationMode}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block">Model Family</span>
          <span className="font-medium">{workflow.modelFamily}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block">Target Servers</span>
          <div className="flex gap-1 flex-wrap mt-1">
            {workflow.compatibleServerTags?.length ? (
              workflow.compatibleServerTags.map((t: string) => (
                <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-secondary/50">{t}</Badge>
              ))
            ) : (
              <span className="text-muted-foreground">Any</span>
            )}
          </div>
        </div>
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block">Nodes</span>
          <span className="font-medium font-mono">{workflow.nodes?.length || 0}</span>
        </div>
      </div>

      {workflow.mappings && Object.keys(workflow.mappings).length > 0 && (
        <div className="mt-4 pt-4 border-t border-border/50">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">Active Mappings</span>
            <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowJson(!showJson)}>
              {showJson ? "Hide JSON" : "View JSON"}
            </Button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(workflow.mappings).map(([variable, mapping]: [string, any]) => (
              <div key={variable} className="bg-secondary/20 p-2 rounded flex flex-col gap-1 border border-border/50">
                <span className="text-xs font-semibold">{variable}</span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  Node {mapping.nodeId} → {mapping.input}
                </span>
              </div>
            ))}
          </div>
          {showJson && (
            <div className="mt-4 bg-background/80 p-3 rounded-md border border-border/50 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
              {isLoading ? "Loading..." : JSON.stringify(fullWorkflow?.nodes, null, 2)}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function WorkflowForm({ onSuccess }: { onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createMutation = useCreateWorkflow();

  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setJsonError("");

    let apiWorkflow = {};
    try {
      apiWorkflow = JSON.parse(jsonText);
    } catch (err) {
      setJsonError("Invalid JSON format. Please paste valid ComfyUI API JSON.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    const tagsStr = formData.get("compatibleServerTags") as string;
    const compatibleServerTags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(Boolean) : [];

    // Construct basic mappings mapping defaults
    // In a real app, we'd have a visual mapper here, but for this form we'll auto-generate
    // a basic skeleton or leave it empty to be filled by the API logic if possible.
    const mappingsStr = formData.get("mappingsStr") as string;
    let mappings = {};
    if (mappingsStr) {
      try {
        mappings = JSON.parse(mappingsStr);
      } catch (err) {
        setJsonError("Invalid mappings JSON format.");
        return;
      }
    }

    const data = {
      name: formData.get("name") as string,
      description: formData.get("description") as string,
      generationMode: formData.get("generationMode") as string,
      modelFamily: formData.get("modelFamily") as string,
      compatibleServerTags,
      apiWorkflow,
      mappings: Object.keys(mappings).length > 0 ? mappings : undefined
    };

    try {
      await createMutation.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getListWorkflowsQueryKey() });
      onSuccess();
    } catch (err: any) {
      setJsonError(err.message || "Failed to create workflow.");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required className="bg-secondary/20" placeholder="SDXL High Res" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="generationMode">Mode</Label>
          <Input id="generationMode" name="generationMode" required className="bg-secondary/20" placeholder="txt2vid" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input id="description" name="description" className="bg-secondary/20" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="modelFamily">Model Family</Label>
          <Input id="modelFamily" name="modelFamily" required className="bg-secondary/20" placeholder="sdxl" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="compatibleServerTags">Server Tags (comma separated)</Label>
          <Input id="compatibleServerTags" name="compatibleServerTags" className="bg-secondary/20" placeholder="sdxl, fast" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="apiWorkflow">ComfyUI API JSON</Label>
        <Textarea 
          id="apiWorkflow" 
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          required 
          className="h-40 bg-secondary/20 font-mono text-[10px]"
          placeholder='{"3": {"class_type": "KSampler", ...}}'
        />
        {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="mappingsStr">Mappings JSON (Optional Override)</Label>
        <Textarea 
          id="mappingsStr" 
          name="mappingsStr"
          className="h-24 bg-secondary/20 font-mono text-[10px]"
          placeholder='{"positive_prompt": {"nodeId": "6", "input": "text"}}'
        />
      </div>

      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Importing..." : "Import Template"}
        </Button>
      </div>
    </form>
  );
}