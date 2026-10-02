export type GarmentMode = "replace-garment" | "animate-artwork";

/** Animate mode only: animate the artwork already printed on the target garment, or an uploaded design. */
export type GarmentArtworkSource = "existing" | "upload";

export interface GarmentSource {
  mediaUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface GarmentWorker {
  id: string;
  name: string;
  ready: boolean;
  busy: boolean;
  /** Human-readable reason when not ready (driver, model missing, offline). */
  reason?: string | null;
}

export type GarmentJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface GarmentJob {
  id: string;
  status: GarmentJobStatus;
  /** Free-form stage label from the pipeline, e.g. "segmenting", "generating", "compositing". */
  stage?: string | null;
  maskUrl?: string | null;
  outputUrl?: string | null;
  error?: string | null;
  /** Original (source) clip URL saved with the job. */
  sourceUrl?: string | null;
  title?: string;
  createdAt?: string;
  mode?: GarmentMode;
}

export interface GarmentReference {
  storageKey: string;
  mediaUrl: string;
  name: string;
}

export interface GarmentSubmitRequest {
  workerId: string;
  mode: GarmentMode;
  prompt: string;
  /** Free-text description of which garment to edit, e.g. "jacket worn by the person on the left". */
  targetGarment: string;
  /** Sent only for animate-artwork. */
  artworkSource?: GarmentArtworkSource;
  startSeconds: number;
  durationSeconds: number;
  seed: number;
}

export interface GarmentWorkbenchProps {
  source: GarmentSource | null;
  workers: GarmentWorker[];
  job: GarmentJob | null;
  onUpload: (file: File) => void;
  onSubmit: (request: GarmentSubmitRequest) => void;
  onCancel: (jobId: string) => void;
  /** True while the parent is uploading or submitting. */
  loading?: boolean;
  /** Parent-level error message (upload, submit, cancel). */
  error?: string | null;
  reference?: GarmentReference | null;
  referenceUploading?: boolean;
  onReferenceUpload?: (file: File) => void;
  onReferenceClear?: () => void;
  /** Called whenever an input that defines the request changes (used to rotate request IDs). */
  onInputChange?: () => void;
  /** Reports the selected artwork source so the parent knows whether the reference image is used. */
  onArtworkSourceChange?: (source: GarmentArtworkSource) => void;
}
