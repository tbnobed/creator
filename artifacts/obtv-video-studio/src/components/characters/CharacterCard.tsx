import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Edit2, Image as ImageIcon, Mic2, Trash2 } from "lucide-react";
import { Character } from "@workspace/api-client-react";

export function CharacterCard({
  character,
  onEdit,
  onDelete,
}: {
  character: Character;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden group flex flex-col border-border/50 hover:border-primary/50 transition-colors bg-card/30 backdrop-blur-sm">
      <div className="aspect-video bg-secondary/30 relative flex items-center justify-center border-b border-border/50 overflow-hidden">
        {character.thumbnail ? (
          <img
            src={character.thumbnail}
            alt={character.name}
            loading="lazy"
            decoding="async"
            className="object-cover w-full h-full opacity-80 group-hover:opacity-100 transition-opacity"
          />
        ) : (
          <ImageIcon className="size-10 text-muted-foreground/30" />
        )}
        <div className="absolute top-2 right-2 flex gap-1">
          <Button
            size="icon"
            variant="secondary"
            className="size-8 h-8 w-8 bg-background/90 backdrop-blur shadow-md hover-elevate"
            onClick={() => onEdit(character.id)}
            aria-label={`Edit ${character.name}`}
            title={`Edit ${character.name}`}
            data-testid={`button-edit-character-${character.id}`}
          >
            <Edit2 className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="destructive"
            className="size-8 h-8 w-8 shadow-md hover-elevate"
            onClick={() => onDelete(character.id)}
            aria-label={`Delete ${character.name}`}
            title={`Delete ${character.name}`}
            data-testid={`button-delete-character-${character.id}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="p-4 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-2">
          <h3 className="font-semibold text-lg line-clamp-1">{character.name}</h3>
          <div className="flex gap-1">
            {character.hasVoiceSample && (
              <Badge variant="secondary" className="gap-1 bg-secondary/60">
                <Mic2 className="size-3" /> Voice
              </Badge>
            )}
            <Badge variant="outline" className="bg-background/50">
              {character.assetCount} assets
            </Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">
          {character.description || "No description provided."}
        </p>
        <div className="flex flex-wrap gap-1">
          {character.tags?.slice(0, 3).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-xs px-2 py-0 h-5 bg-secondary/40"
            >
              {tag}
            </Badge>
          ))}
          {(character.tags?.length || 0) > 3 && (
            <Badge
              variant="secondary"
              className="text-xs px-2 py-0 h-5 bg-secondary/40"
            >
              +{character.tags!.length - 3}
            </Badge>
          )}
        </div>
      </div>
    </Card>
  );
}
