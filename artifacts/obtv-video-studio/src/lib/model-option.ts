// One presentation shape for image and video model choices. Capability rules stay in each
// domain adapter; only the option label, provider badge and disabled reason are shared.

export interface ModelOptionView { id: string; label: string; paid: boolean; reason: string | null; note?: string }

export function imageModelOption(m: { id: string; name: string; provider: string; priceNote?: string | null }, reason: string | null): ModelOptionView {
  return { id: m.id, label: m.name, paid: m.provider === "CLOUD", reason, note: m.provider === "CLOUD" ? m.priceNote ?? undefined : undefined };
}

export function videoCloudOption(o: { value: string; label: string; rate?: number }, reason: string | null = null): ModelOptionView {
  return { id: o.value, label: o.label, paid: true, reason, note: o.rate != null ? `~$${o.rate.toFixed(3)}/s estimated` : undefined };
}

/** Groups local first, then paid, so paid models are never the visual default. */
export function groupModelOptions(options: ModelOptionView[]): { heading: string; paid: boolean; options: ModelOptionView[] }[] {
  const local = options.filter((o) => !o.paid), paid = options.filter((o) => o.paid);
  return [
    ...(local.length ? [{ heading: "Your GPUs · local", paid: false, options: local }] : []),
    ...(paid.length ? [{ heading: "Cloud · cost applies", paid: true, options: paid }] : []),
  ];
}
