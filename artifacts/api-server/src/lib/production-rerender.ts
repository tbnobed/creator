type ShotUpdate = { shot: { id: string; status: string }; prompt: string };
type RerenderServices = {
  pause: (id: string, options: { forCorrection: boolean }) => Promise<unknown>;
  update: (id: string, shotId: string, input: { prompt: string }, options: { deferStart: boolean }) => Promise<unknown>;
  retry: (id: string, shotId: string, options: { deferStart: boolean }) => Promise<unknown>;
  start: (id: string) => Promise<unknown>;
};

/** Prepare the whole correction before allowing background dispatch to acquire its lock. */
export async function prepareProductionRerenders(projectId: string, updates: ShotUpdate[], services: RerenderServices): Promise<void> {
  await services.pause(projectId, { forCorrection: true });
  for (const { shot, prompt } of updates) {
    await services.update(projectId, shot.id, { prompt }, { deferStart: true });
    if (shot.status === "FAILED" || shot.status === "CANCELLED") {
      await services.retry(projectId, shot.id, { deferStart: true });
    }
  }
  // Start owns dispatch. No earlier operation can schedule competing orchestration.
  await services.start(projectId);
}
