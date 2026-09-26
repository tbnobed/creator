import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkDeleteVideoLibrary, getListGenerationsQueryKey, getListReferenceLibraryQueryKey, getListVideoLibraryQueryKey, importReferenceLibrary,
  listReferenceLibrary, listVideoLibrary, setVideoLibraryFavorites, undoVideoLibraryDelete,
} from "@workspace/api-client-react";

// Thin wrappers over the generated video/reference library client adding friendly errors.

export type VideoLibraryItem = {
  id: string;
  title: string | null;
  status: string;
  favorite: boolean;
  outputStorageKey: string | null;
  mediaUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
};
export type ReferenceKind = "image" | "video" | "audio";
export type ReferenceRole = "referenceImage" | "firstFrame" | "lastFrame" | "referenceVideo" | "referenceAudio";
export type ReferenceSourceType = "upload" | "referenceVideo" | "generation" | "imageAsset" | "characterAsset" | "settingAsset";
export type ReferenceLibraryItem = {
  sourceType: ReferenceSourceType;
  sourceId: string;
  name: string;
  kind: ReferenceKind;
  mimeType: string;
  mediaUrl: string;
  previewUrl: string | null;
  createdAt: string;
};

function friendly(cause: unknown): Error {
  const status = typeof cause === "object" && cause && "status" in cause ? Number((cause as { status: unknown }).status) : 0;
  const fallback = status === 410 ? "The undo window has expired." : status === 409 ? "Active jobs must finish or be cancelled first." : status === 404 ? "Some items no longer exist." : status === 415 ? "This file type cannot be used as a reference." : "Request failed. Please try again.";
  const data = typeof cause === "object" && cause && "data" in cause ? (cause as { data: unknown }).data : null;
  const message = data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string" ? (data as { error: string }).error : fallback;
  return new Error(message);
}
async function call<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (cause) { throw friendly(cause); }
}

export const videoLibraryKey = (favorite?: boolean) => getListVideoLibraryQueryKey(favorite === undefined ? undefined : { favorite });

export function useVideoLibrary(favorite?: boolean) {
  return useQuery({
    queryKey: videoLibraryKey(favorite),
    queryFn: () => call(() => listVideoLibrary(favorite === undefined ? undefined : { favorite })),
  });
}

function useInvalidateLibrary() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: getListVideoLibraryQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListGenerationsQueryKey() });
  };
}

export function useSetVideoFavorites() {
  const invalidate = useInvalidateLibrary();
  return useMutation({ mutationFn: (body: { ids: string[]; favorite: boolean }) => call(() => setVideoLibraryFavorites(body)), onSuccess: invalidate });
}

export function useBulkDeleteVideos() {
  const invalidate = useInvalidateLibrary();
  return useMutation({ mutationFn: (ids: string[]) => call(() => bulkDeleteVideoLibrary({ ids })), onSuccess: invalidate });
}

export function useUndoVideoDelete() {
  const invalidate = useInvalidateLibrary();
  return useMutation({ mutationFn: (undoToken: string) => call(() => undoVideoLibraryDelete({ undoToken })), onSuccess: invalidate });
}

export function useReferenceLibrary(kind: ReferenceKind, role: ReferenceRole, enabled: boolean) {
  return useQuery({
    queryKey: getListReferenceLibraryQueryKey({ kind, role }),
    queryFn: () => call(() => listReferenceLibrary({ kind, role })),
    enabled,
  });
}

export function importReference(body: { sourceType: ReferenceSourceType; sourceId: string; role?: ReferenceRole }) {
  return call(() => importReferenceLibrary(body));
}

export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

export { nextSelection } from "./selection";
