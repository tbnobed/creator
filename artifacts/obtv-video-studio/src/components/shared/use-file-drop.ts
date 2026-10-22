import { useState, type DragEvent } from "react";
import { pickAccepted } from "@/lib/file-accept";

/**
 * Drag/drop + input wiring shared by tool-specific upload areas (Image Studio, Video Replacement).
 * Keeps each tool's own visuals and domain checks; enforces its accept list on drop as well as click.
 */
export function useFileDrop({ accept, multiple, disabled, noun, onFiles, onReject }: {
  accept: string; multiple?: boolean; disabled?: boolean; noun?: string; onFiles: (files: File[]) => void; onReject: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const take = (list: FileList | null | undefined) => {
    const r = pickAccepted(list, accept, multiple, noun);
    if (r.ok) onFiles(r.files); else if (r.error) onReject(r.error);
  };
  return {
    dragging,
    take,
    dropProps: {
      onDragOver: (e: DragEvent) => { e.preventDefault(); if (!disabled) setDragging(true); },
      onDragLeave: () => setDragging(false),
      onDrop: (e: DragEvent) => { e.preventDefault(); setDragging(false); if (!disabled) take(e.dataTransfer.files); },
    },
    inputProps: { accept, multiple, disabled, onChange: (e: { target: HTMLInputElement }) => { take(e.target.files); e.target.value = ""; } },
  };
}
