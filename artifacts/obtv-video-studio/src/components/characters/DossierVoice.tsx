import { useState } from "react";
import { Character, getListCharactersQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mic2, Loader2, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export function DossierVoice({ 
  characterId, 
  character 
}: { 
  characterId: string; 
  character?: Character;
}) {
  const [voicePending, setVoicePending] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleVoiceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!consentConfirmed) {
      toast({ title: "Consent required", description: "You must confirm you have permission to clone this voice.", variant: "destructive" });
      e.target.value = "";
      return;
    }

    setVoicePending(true);
    try {
      const suppliedType = file.type.split(";")[0].toLowerCase();
      const contentType = /\.wav$/i.test(file.name)
        || ["audio/wave", "audio/vnd.wave"].includes(suppliedType)
        ? "audio/wav"
        : suppliedType || "audio/wav";
      
      const response = await fetch(`/api/characters/${characterId}/voice-sample`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-file-name": encodeURIComponent(file.name),
          "x-voice-consent": "confirmed",
        },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Voice sample upload failed");
      
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      toast({ title: "Voice sample uploaded successfully" });
    } catch (err: any) {
      toast({ title: "Error uploading voice", description: err.message, variant: "destructive" });
    } finally {
      setVoicePending(false);
      e.target.value = "";
    }
  };

  const removeVoiceSample = async () => {
    if (!confirm("Are you sure you want to remove the voice clone?")) return;
    
    setVoicePending(true);
    try {
      const response = await fetch(`/api/characters/${characterId}/voice-sample`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove the voice sample");
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      toast({ title: "Voice sample removed" });
    } catch (err: any) {
      toast({ title: "Error removing voice", description: err.message, variant: "destructive" });
    } finally {
      setVoicePending(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-lg font-semibold mb-1">Voice Cloning</h3>
        <p className="text-sm text-muted-foreground">Give your character a unique, consistent voice across all generations.</p>
      </div>

      <div className="p-6 rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm space-y-6">
        <div className="flex items-start gap-4 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-500">
          <Info className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold mb-1">Voice cloning remains strictly optional.</p>
            <p className="opacity-90">Voice cloning uses consented sample when explicitly enabled for generation, results may vary. Auto-enable is disabled.</p>
          </div>
        </div>

        <div className="space-y-4">
          <Label>Voice Sample Requirements</Label>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>5–20 seconds in length</li>
            <li>One person speaking clearly</li>
            <li>No background music, echo, or other voices</li>
            <li>WAV, MP3, M4A, WEBM, or OGG format</li>
          </ul>
        </div>

        {character?.voiceSampleUrl ? (
          <div className="p-4 rounded-lg border border-border/50 bg-secondary/20 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-500 font-medium">
                <Mic2 className="w-4 h-4" /> Voice Ready
              </div>
              <Button type="button" variant="outline" size="sm" disabled={voicePending} onClick={removeVoiceSample}>
                Remove Voice
              </Button>
            </div>
            <audio controls preload="metadata" src={character.voiceSampleUrl} className="w-full h-10" />
          </div>
        ) : (
          <div className="space-y-4 pt-4 border-t border-border/50">
            <label className="flex items-start gap-3 text-sm text-muted-foreground p-3 rounded-lg border border-border/50 bg-secondary/10 hover:bg-secondary/20 transition-colors cursor-pointer">
              <input 
                type="checkbox" 
                className="mt-0.5 size-4 rounded-sm border-primary/50 text-primary focus:ring-primary"
                checked={consentConfirmed}
                onChange={(e) => setConsentConfirmed(e.target.checked)}
              />
              <span className="font-medium text-foreground">
                I confirm I own this voice or have the speaker’s permission to create and use a cloned voice for this character.
              </span>
            </label>
            
            <div className="space-y-2">
              <Label htmlFor="voiceSample">Upload Audio File</Label>
              <Input
                id="voiceSample"
                type="file"
                disabled={voicePending || !consentConfirmed}
                accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg"
                className="bg-secondary/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                onChange={handleVoiceUpload}
              />
            </div>
            {voicePending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Uploading and processing...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
