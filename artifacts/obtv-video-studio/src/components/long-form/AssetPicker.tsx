import { useState } from "react";
import { useListImageStudioAssets, getListImageStudioAssetsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Search, Image as ImageIcon, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";

export function AssetPicker({
  value,
  onChange,
  triggerClassName,
  placeholder = "Select Asset",
}: {
  value?: string;
  onChange: (assetId: string | undefined) => void;
  triggerClassName?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  
  const queryParams = search ? { search } : undefined;
  const { data: assetsData, isLoading } = useListImageStudioAssets(
    queryParams,
    { query: { enabled: open, queryKey: getListImageStudioAssetsQueryKey(queryParams) } }
  );

  const assets = assetsData?.assets || [];
  const selectedAsset = assets.find((a) => a.id === value);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className={`w-full justify-start ${!value ? "text-muted-foreground" : ""} ${triggerClassName || ""}`}
          type="button"
        >
          <ImageIcon className="w-4 h-4 mr-2" />
          {value ? (selectedAsset ? selectedAsset.name || value : value) : placeholder}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl h-[80vh] flex flex-col p-0">
        <DialogHeader className="p-4 border-b shrink-0">
          <DialogTitle>Select Image Studio Asset</DialogTitle>
        </DialogHeader>

        <div className="p-4 border-b shrink-0 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search images..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {value && (
            <Button variant="secondary" onClick={() => { onChange(undefined); setOpen(false); }}>
              Clear Selection
            </Button>
          )}
        </div>

        <ScrollArea className="flex-1 p-4">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : assets.length === 0 ? (
            <div className="flex flex-col h-40 items-center justify-center text-muted-foreground space-y-3">
              <ImageIcon className="w-10 h-10 opacity-20" />
              <p>No images found.</p>
              <Link href="/image-studio" onClick={() => setOpen(false)}>
                <Button variant="outline" size="sm">Go to Image Studio</Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-10">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => {
                    onChange(asset.id);
                    setOpen(false);
                  }}
                  className={`group relative aspect-square rounded-xl overflow-hidden border-2 transition-all hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${
                    value === asset.id ? "border-primary" : "border-transparent bg-muted"
                  }`}
                >
                  <img
                    src={asset.url}
                    alt={asset.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {value === asset.id && (
                    <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-0.5 shadow-lg">
                      <CheckCircle2 className="w-4 h-4" />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <p className="text-[10px] text-white truncate text-left">{asset.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
