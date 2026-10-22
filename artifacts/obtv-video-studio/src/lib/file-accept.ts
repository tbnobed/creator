/** Accept-list check shared by click and drop; mirrors the input's accept attribute. */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string): boolean {
  const rules = accept.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase(), type = (file.type || "").toLowerCase();
  return rules.some((r) => r.startsWith(".") ? name.endsWith(r) : r.endsWith("/*") ? type.startsWith(r.slice(0, -1)) : type === r);
}


export type PickResult<F> = { ok: true; files: F[] } | { ok: false; error: string };

/** Shared click/drop selection rule: count limit, then accept-list check. Size/duration checks stay per tool. */
export function pickAccepted<F extends { name: string; type: string }>(list: ArrayLike<F> | null | undefined, accept: string, multiple = false, noun = "file"): PickResult<F> {
  const files = Array.from(list ?? []);
  if (files.length === 0) return { ok: false, error: "" };
  if (!multiple && files.length > 1) return { ok: false, error: `Choose one ${noun} at a time.` };
  const bad = files.find((f) => !fileMatchesAccept(f, accept));
  if (bad) return { ok: false, error: `${bad.name} is not a supported ${noun} type.` };
  return { ok: true, files };
}
