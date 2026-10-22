import { Check } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { groupModelOptions, type ModelOptionView } from "@/lib/model-option";

export function ProviderBadge({ paid }: { paid: boolean }) {
  return <span className={`ml-1 text-[10px] font-bold ${paid ? "text-amber-300" : "text-emerald-400"}`}>{paid ? "PAID" : "LOCAL"}</span>;
}

/** Option row content shared by every model select and combobox. */
export function ModelOptionLabel({ option }: { option: ModelOptionView }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{option.label} <ProviderBadge paid={option.paid} /></span>
      {option.reason ? <span className="text-[11px] text-muted-foreground">{option.reason}</span>
        : option.note ? <span className="text-[11px] text-muted-foreground">{option.note}</span> : null}
    </span>
  );
}

/** Searchable grouped list (local first, paid second) used inside a popover combobox. */
export function ModelCommandList({ options, selectedId, onSelect, searchPlaceholder = "Search models...", testIdPrefix }: {
  options: ModelOptionView[]; selectedId: string | null | undefined; onSelect: (id: string) => void; searchPlaceholder?: string; testIdPrefix?: string;
}) {
  return (
    <Command>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty>No models found.</CommandEmpty>
        {groupModelOptions(options).map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.options.map((o) => (
              <CommandItem key={o.id} value={o.label} disabled={!!o.reason} onSelect={() => { if (!o.reason) onSelect(o.id); }}
                data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}>
                <Check className={`mr-2 h-4 w-4 shrink-0 ${selectedId === o.id ? "opacity-100" : "opacity-0"}`} />
                <ModelOptionLabel option={o} />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
