import { Suspense } from "react";
import { ImageWorkspace } from "@/components/image-studio/ImageWorkspace";

export function ImagePage() {
  return (
    <div className="flex min-h-full w-full flex-col bg-background text-foreground md:h-full md:overflow-hidden">
      <Suspense fallback={<div className="flex h-full items-center justify-center">Loading Studio...</div>}>
        <ImageWorkspace />
      </Suspense>
    </div>
  );
}

export default ImagePage;
