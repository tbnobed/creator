import { sanitizeProviderMessage } from "@/lib/provider-messages";

export function cleanupErrorMessage(error: unknown, fallback: string) {
  const e = error as { data?: { error?: unknown }; message?: unknown } | null;
  const raw = typeof e?.data?.error === "string" ? e.data.error : typeof e?.message === "string" ? e.message : fallback;
  return sanitizeProviderMessage(raw);
}
