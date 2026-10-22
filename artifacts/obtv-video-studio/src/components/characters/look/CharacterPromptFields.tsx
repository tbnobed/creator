import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CHARACTER_CHIPS, appendChip, deriveCharacterName } from "@/lib/character-look-adapters";

/**
 * Prompt-first character description shared by the Characters library and Long-Form.
 * Name is optional: when empty, a name is derived from the prompt (server does the same).
 */
export function CharacterPromptFields({ prompt, setPrompt, name, setName, nameDisabled, disabled, onSubmitShortcut, chips = true, testIds }: {
  prompt: string; setPrompt: (v: string) => void; name: string; setName: (v: string) => void;
  nameDisabled?: boolean; disabled?: boolean; onSubmitShortcut?: () => void; chips?: boolean;
  testIds?: { prompt?: string; name?: string };
}) {
  return (
    <div className="space-y-3">
      <Textarea
        aria-label="Describe the character" value={prompt} onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (onSubmitShortcut && e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmitShortcut(); }}
        placeholder="A weathered harbor pilot in her fifties, salt-gray braid, wind-burned cheeks, navy wool peacoat"
        className="min-h-32 resize-none bg-secondary/20" maxLength={4000} disabled={disabled}
        data-testid={testIds?.prompt ?? "input-character-description"}
      />
      {chips && (
        <div className="flex flex-wrap gap-1.5">
          {CHARACTER_CHIPS.map((chip) => (
            <button key={chip} type="button" disabled={disabled} onClick={() => setPrompt(appendChip(prompt, chip))}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-50" data-testid={`chip-${chip.replace(" ", "-")}`}>
              + {chip}
            </button>
          ))}
        </div>
      )}
      <Input
        aria-label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)}
        placeholder={prompt.trim() ? `Name (optional): ${deriveCharacterName(prompt)}` : "Name (optional)"}
        className="bg-secondary/20" disabled={disabled || nameDisabled} data-testid={testIds?.name ?? "input-character-name"}
      />
    </div>
  );
}
