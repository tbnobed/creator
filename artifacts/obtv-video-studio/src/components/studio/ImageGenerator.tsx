import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sparkles, Image as ImageIcon, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ImageGeneratorProps {
  onGenerate: (prompt: string, seed?: number) => Promise<string>;
  defaultPrompt?: string;
}

export function ImageGenerator({ onGenerate, defaultPrompt = "" }: ImageGeneratorProps) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [seed, setSeed] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const { toast } = useToast();

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast({ title: "Prompt required", description: "Please enter a prompt to generate an image.", variant: "destructive" });
      return;
    }
    let parsedSeed: number | undefined = undefined;
    if (seed) {
      parsedSeed = parseInt(seed, 10);
      if (!Number.isFinite(parsedSeed)) {
        toast({ title: "Invalid seed", description: "Seed must be a valid finite number.", variant: "destructive" });
        return;
      }
    }
    try {
      setIsGenerating(true);
      setGeneratedUrl(null);
      const url = await onGenerate(prompt, parsedSeed);
      setGeneratedUrl(url);
      toast({ title: "Image generated", description: "Successfully generated image." });
    } catch (err: any) {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-card/30">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="size-4 text-primary" />
        <h4 className="text-sm font-medium">Generate Image</h4>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Prompt</Label>
          <Textarea
            placeholder="Describe the image..."
            className="h-16 text-xs resize-none bg-background/50"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs text-muted-foreground">Seed (optional)</Label>
            <Input
              type="number"
              placeholder="Random"
              className="h-8 text-xs bg-background/50"
              value={seed}
              onChange={e => setSeed(e.target.value)}
              min={0}
              max={2147483647}
              step={1}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="h-8 gap-1.5"
            >
              {isGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
              {isGenerating ? "Generating..." : "Generate"}
            </Button>
          </div>
        </div>
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
