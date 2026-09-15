import { useState } from "react";
import { useListCharacters, useDeleteCharacter, getListCharactersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/layout/page";
import { Plus, Users, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { CharacterCard } from "@/components/characters/CharacterCard";
import { CharacterDossierDialog } from "@/components/characters/CharacterDossierDialog";

export default function CharactersPage() {
  const { data: characters, isLoading } = useListCharacters();
  const [search, setSearch] = useState("");
  const [isDossierOpen, setIsDossierOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteCharacter();

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this character?")) {
      await deleteMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    }
  };

  const handleEdit = (id: string) => {
    setEditingId(id);
    setIsDossierOpen(true);
  };

  const handleCreateNew = () => {
    setEditingId(null);
    setIsDossierOpen(true);
  };

  const filteredCharacters = characters?.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) || 
    c.tags?.some(t => t.toLowerCase().includes(search.toLowerCase())) ||
    c.description?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Page>
      <PageHeader
        title="Cast Library"
        description="Manage recurring characters, their approved wardrobes, and performance rules."
        actions={
          <Button onClick={handleCreateNew} className="gap-2 shadow-lg hover-elevate">
            <Plus className="size-4" />
            New Character Dossier
          </Button>
        }
      />

      <div className="mb-6 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input 
          placeholder="Search cast by name, role, or tags..." 
          className="pl-9 bg-card/50 border-border/50 focus-visible:ring-primary/50"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => (
            <Card key={i} className="h-[22rem] bg-card/50 border-border/50 animate-pulse" />
          ))}
        </div>
      ) : characters?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg border-border/50 bg-card/10 mt-10">
          <div className="size-16 rounded-full bg-secondary/50 flex items-center justify-center mb-4">
            <Users className="size-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold mb-2">Cast is empty</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            Build your character dossiers with approved visual references, wardrobes, and behavior notes to lock in continuity.
          </p>
          <Button onClick={handleCreateNew}>Create first character</Button>
        </div>
      ) : filteredCharacters?.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          No characters match your search.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {filteredCharacters?.map(char => (
            <CharacterCard 
              key={char.id} 
              character={char} 
              onEdit={handleEdit} 
              onDelete={handleDelete} 
            />
          ))}
        </div>
      )}

      <CharacterDossierDialog 
        characterId={editingId} 
        open={isDossierOpen} 
        onOpenChange={setIsDossierOpen} 
      />
    </Page>
  );
}
