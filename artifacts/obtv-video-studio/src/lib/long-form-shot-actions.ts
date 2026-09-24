export type LongFormShotStatus = "PLANNED" | "QUEUED" | "RENDERING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type LongFormProjectStatus = "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "EDITING" | "ASSEMBLING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type LongFormShotActionState = {
  edit: {
    visible: true;
    enabled: boolean;
  };
  regenerate: {
    visible: boolean;
    enabled: boolean;
  };
  retry: {
    visible: boolean;
    enabled: boolean;
  };
  disabledReason?: string;
};

const editableShotStatuses = new Set<LongFormShotStatus>(["PLANNED", "FAILED", "CANCELLED", "COMPLETED"]);
const retryableShotStatuses = new Set<LongFormShotStatus>(["FAILED", "CANCELLED"]);
const activeShotStatuses = new Set<LongFormShotStatus>(["QUEUED", "RENDERING"]);

export function longFormShotActionState(input: {
  shotStatus: LongFormShotStatus;
  projectStatus: LongFormProjectStatus;
  continuityEnabled: boolean;
  activeShotCount: number;
}): LongFormShotActionState {
  const { shotStatus, projectStatus, continuityEnabled, activeShotCount } = input;
  let disabledReason: string | undefined;

  if (projectStatus === "ASSEMBLING") {
    disabledReason = "Wait for final video assembly to finish before editing or regenerating shots.";
  } else if (shotStatus === "QUEUED" || shotStatus === "RENDERING") {
    disabledReason = "This shot is currently rendering; editing is available after it finishes.";
  } else if (!editableShotStatuses.has(shotStatus)) {
    disabledReason = "This shot is not available for editing in its current state.";
  } else if (continuityEnabled && shotStatus === "COMPLETED" && (projectStatus === "RUNNING" || activeShotCount > 0)) {
    disabledReason = "Pause production and wait for active renders to finish before preparing a continuity revision.";
  }

  const editEnabled = !disabledReason;
  return {
    edit: { visible: true, enabled: editEnabled },
    regenerate: {
      visible: shotStatus === "COMPLETED" || activeShotStatuses.has(shotStatus),
      enabled: shotStatus === "COMPLETED" && editEnabled,
    },
    retry: {
      visible: retryableShotStatuses.has(shotStatus),
      enabled: retryableShotStatuses.has(shotStatus) && projectStatus !== "ASSEMBLING",
    },
    ...(disabledReason ? { disabledReason } : {}),
  };
}