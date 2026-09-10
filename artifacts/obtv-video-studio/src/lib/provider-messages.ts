const PROVIDER_BRAND_PATTERN = /\bfal(?:\.ai)?\b/gi;
const PROVIDER_URL_PATTERN = /(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run)[^\s"'<>]*/gi;

export function sanitizeProviderMessage(message: unknown, fallback = "An unexpected error occurred."): string {
  if (typeof message !== "string" || !message.trim()) return fallback;
  return message
    .replace(PROVIDER_URL_PATTERN, "Cloud")
    .replace(PROVIDER_BRAND_PATTERN, "Cloud");
}