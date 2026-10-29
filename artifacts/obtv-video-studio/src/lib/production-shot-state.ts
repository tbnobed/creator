export function shotIsRendering(status: string): boolean {
  return status === "QUEUED" || status === "RENDERING";
}

export function shotRerenderDisabled(status: string, busy: boolean): boolean {
  return busy || shotIsRendering(status);
}

export function renderNeedsPolling(project: { status: string; shots?: { status: string }[] }): boolean {
  return ["RUNNING", "ASSEMBLING"].includes(project.status) || !!project.shots?.some(shot => shotIsRendering(shot.status));
}
