/** ComfyUI reports vram_total/free; older workers use total/free_memory. */
export function comfyDeviceMemory(device: unknown) {
  const d = (device && typeof device === "object" ? device : {}) as Record<string, unknown>;
  const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const total = valid(d.vram_total) ? d.vram_total : d.total_memory;
  const free = valid(d.vram_free) ? d.vram_free : d.free_memory;
  const gb = (bytes: number) => Math.round(bytes / 1024 ** 3 * 10) / 10;
  return {
    vramGb: valid(total) && total > 0 ? gb(total) : null,
    memoryUsedGb: valid(total) && total > 0 && valid(free) && free <= total ? gb(total - free) : null,
  };
}
