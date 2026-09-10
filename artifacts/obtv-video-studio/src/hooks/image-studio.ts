import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  useListImageStudioModels,
  useListImageStudioJobs,
  useGetImageStudioJob,
  useCreateImageStudioJob,
  useCancelImageStudioJob,
  useDeleteImageStudioJob,
  useListImageStudioAssets,
  useUpdateImageStudioAsset,
  useDeleteImageStudioAsset,
  uploadImageStudioAsset,
  ImageModel as GenImageModel,
  ImageJob as GenImageJob,
  ImageAsset as GenImageAsset,
  ImageAssetList,
  ImageJobList,
} from "@workspace/api-client-react";
import { sanitizeProviderMessage } from "@/lib/provider-messages";

// Re-export generated types to maintain compatibility with UI
export type ImageModel = GenImageModel;
export type ImageJob = GenImageJob;
export type ImageAsset = GenImageAsset;
export type ImageJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type WorkspaceMode = "generate" | "edit" | "inpaint" | "outpaint" | "upscale" | "remove-background";

export function imageStudioError(error: unknown, fallback = "The request could not be completed."): string {
  const candidate = error as { message?: unknown; data?: { error?: unknown; message?: unknown } };
  return sanitizeProviderMessage(
    candidate?.data?.error ?? candidate?.data?.message ?? candidate?.message,
    fallback,
  );
}

export function isTransportError(error: unknown): boolean {
  return !(error && typeof error === "object" && "status" in error);
}

export function useGetModels() {
  return useListImageStudioModels({
    query: {
      queryKey: ["/api/image-studio/models"],
      staleTime: 30000,
      refetchInterval: 30000,
    }
  });
}

export function useGetJobs() {
  const qc = useQueryClient();
  const previousStatuses = useRef(new Map<string, ImageJobStatus>());
  const query = useListImageStudioJobs(undefined, {
    query: {
      queryKey: ["/api/image-studio/jobs"],
      refetchInterval: (query) => {
        const jobs = query.state.data?.jobs;
        if (jobs?.some(j => j.status === "QUEUED" || j.status === "RUNNING")) {
          return 3000;
        }
        return false;
      },
    }
  });
  useEffect(() => {
    const jobs = query.data?.jobs;
    if (!jobs) return;
    let newlyCompleted = false;
    for (const job of jobs) {
      const previous = previousStatuses.current.get(job.id);
      if (job.status === "COMPLETED" && previous && previous !== "COMPLETED") {
        newlyCompleted = true;
      }
      previousStatuses.current.set(job.id, job.status as ImageJobStatus);
    }
    if (newlyCompleted) {
      void qc.invalidateQueries({ queryKey: ["/api/image-studio/assets"] });
    }
  }, [query.data?.jobs, qc]);
  return query;
}

export function useGetJob(id: string) {
  return useGetImageStudioJob(id, {
    query: {
      queryKey: ["/api/image-studio/jobs", id],
      enabled: !!id,
      refetchInterval: (query) => {
        const job = query.state.data?.job;
        if (job && (job.status === "QUEUED" || job.status === "RUNNING")) {
          return 2000;
        }
        return false;
      },
    }
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  const mutation = useCreateImageStudioJob({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/image-studio/jobs"] });
      }
    }
  });
  return mutation;
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useCancelImageStudioJob({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({ queryKey: ["/api/image-studio/jobs"] });
        if (res.job) {
          qc.setQueryData(["/api/image-studio/jobs", res.job.id], res);
        }
      }
    }
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useDeleteImageStudioJob({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/image-studio/jobs"] });
      }
    }
  });
}

export function useGetAssets(params?: { search?: string; favorite?: boolean; collection?: string }) {
  return useListImageStudioAssets({
    search: params?.search,
    favorite: params?.favorite,
    collection: params?.collection,
  }, {
    query: {
      queryKey: ["/api/image-studio/assets", params],
    }
  });
}

export function useUploadAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["uploadImageStudioAsset"],
    mutationFn: ({ data }: { data: Blob }) => {
      const mimeType = data.type || "image/png";
      const fileName = data instanceof File ? data.name : "image.png";
      const headerFileName = fileName.replace(/[^\x20-\x7e]/g, "_").slice(0, 255);
      return uploadImageStudioAsset(data, {
        headers: {
          "Content-Type": mimeType,
          "X-File-Name": headerFileName,
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/image-studio/assets"] });
    },
  });
}

export function useUpdateAsset() {
  const qc = useQueryClient();
  return useUpdateImageStudioAsset({
    mutation: {
      onSuccess: (result) => {
        qc.setQueriesData<ImageAssetList>(
          { queryKey: ["/api/image-studio/assets"] },
          (current) => current
            ? { ...current, assets: current.assets.map((asset) => asset.id === result.asset.id ? result.asset : asset) }
            : current,
        );
        qc.setQueriesData<ImageJobList>(
          { queryKey: ["/api/image-studio/jobs"] },
          (current) => current
            ? {
                ...current,
                jobs: current.jobs.map((job) => ({
                  ...job,
                  assets: job.assets.map((asset) => asset.id === result.asset.id ? result.asset : asset),
                })),
              }
            : current,
        );
        void qc.invalidateQueries({ queryKey: ["/api/image-studio/assets"] });
      }
    }
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useDeleteImageStudioAsset({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["/api/image-studio/assets"] });
      }
    }
  });
}
