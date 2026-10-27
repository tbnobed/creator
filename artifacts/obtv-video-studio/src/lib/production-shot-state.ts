export function shotIsRendering(status: string): boolean {
  return status === "QUEUED" || status === "RENDERING";
}

export function correctionIsDisabled(status: string, correction: string, busy: boolean): boolean {
  return busy || shotIsRendering(status) || !correction.trim();
}

export function renderNeedsPolling(project: { status: string; shots?: { status: string }[] }): boolean {
  return ["RUNNING", "ASSEMBLING"].includes(project.status) || !!project.shots?.some(shot => shotIsRendering(shot.status));
}
