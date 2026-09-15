import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, FormItem, FormLabel, FormControl } from "@/components/ui/form";
import { Trash2, Plus, Shirt } from "lucide-react";
import { AssetPicker } from "@/components/long-form/AssetPicker";
import { useFieldArray, UseFormReturn } from "react-hook-form";

export function DossierWardrobe({ form }: { form: UseFormReturn<any> }) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "wardrobes",
  });

  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-lg font-semibold mb-1">Wardrobe Library</h3>
          <p className="text-sm text-muted-foreground">Define reusable outfits to maintain continuity across scenes.</p>
        </div>
        <Button type="button" onClick={() => append({ id: crypto.randomUUID(), name: "New Outfit", description: "", referenceAssetId: undefined })} size="sm" className="gap-2">
          <Plus className="w-4 h-4" /> Add Outfit
        </Button>
      </div>
      
      {fields.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed rounded-xl border-border/50 bg-card/10 flex-1">
          <Shirt className="w-12 h-12 text-muted-foreground/30 mb-4" />
          <h4 className="text-lg font-medium mb-1">No outfits defined</h4>
          <p className="text-sm text-muted-foreground mb-4 max-w-sm">
            Create named wardrobe presets with reference images to easily apply them in your scripts and storyboards.
          </p>
          <Button type="button" onClick={() => append({ id: crypto.randomUUID(), name: "New Outfit", description: "", referenceAssetId: undefined })} variant="secondary">
            Create First Outfit
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-20">
          {fields.map((outfit, index) => (
            <div key={outfit.id} className="p-5 rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm space-y-4">
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1 space-y-1">
                  <FormField
                    control={form.control}
                    name={`wardrobes.${index}.name`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Outfit Name</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="e.g. Heist Suit" className="bg-secondary/20 font-medium" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <Button 
                  type="button"
                  variant="ghost" 
                  size="icon" 
                  className="text-muted-foreground hover:text-destructive shrink-0 mt-6"
                  onClick={() => remove(index)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="space-y-1">
                <FormField
                  control={form.control}
                  name={`wardrobes.${index}.description`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea {...field} placeholder="Detailed description..." className="h-20 resize-none bg-secondary/20" />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="space-y-1">
                <FormField
                  control={form.control}
                  name={`wardrobes.${index}.referenceAssetId`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference Asset (Optional)</FormLabel>
                      <FormControl>
                        <AssetPicker 
                          value={field.value || undefined} 
                          onChange={field.onChange}
                          placeholder="Select Image Studio Asset"
                          triggerClassName="bg-secondary/20"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
