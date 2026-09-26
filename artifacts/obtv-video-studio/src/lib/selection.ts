/** Pure selection helper: toggle or shift-range select over an ordered id list. */
export function nextSelection(order: string[], selected: Set<string>, id: string, anchor: string | null, range: boolean): Set<string> {
  const next = new Set(selected);
  if (range && anchor && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    for (const value of order.slice(a, b + 1)) next.add(value);
    return next;
  }
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
