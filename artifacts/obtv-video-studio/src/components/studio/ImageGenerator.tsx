import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sparkles, Image as ImageIcon, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ImageGeneratorProps {
  onGenerate: (prompt: string) => Promise<string>;
  defaultPrompt?: string;
}

export function ImageGenerator({ onGenerate, defaultPrompt = "" }: ImageGeneratorProps) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const { toast } = useToast();

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast({ title: "Prompt required", description: "Please enter a prompt to generate an image.", variant: "destructive" });
      return;
    }
    try {
      setIsGenerating(true);
      setGeneratedUrl(null);
      const url = await onGenerate(prompt);
      setGeneratedUrl(url);
      toast({ title: "Image generated", description: "Successfully generated image." });
    } catch (err: any) {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card/30 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <div>
          <h4 className="text-sm font-medium">Generate a reference image</h4>
          <p className="text-xs text-muted-foreground">Describe the look you want. A random seed is chosen automatically.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Image prompt</Label>
        <Textarea
          placeholder="Describe the reference image..."
          className="min-h-20 resize-none bg-background/50 text-sm"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleGenerate}
          disabled={isGenerating}
          className="gap-1.5"
        >
          {isGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
          {isGenerating ? "Generating..." : "Generate image"}
        </Button>
      </div>

      {generatedUrl && (
        <div className="pt-2">
          <div className="aspect-video relative rounded-md overflow-hidden bg-secondary/30 border">
            <img src={generatedUrl} alt="Generated" className="object-cover w-full h-full" />
          </div>
        </div>
      )}
    </div>
  );
}
