/** Explicit deployment origins plus this workspace's exact HTTPS preview hosts. */
export function browserOrigins(env: Record<string, string | undefined>): Set<string> {
  const origins = new Set(
    (env.APP_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );

  // Never import development host permissions into Docker/production.
  if (env.NODE_ENV !== "development") return origins;

  const hosts = [env.REPLIT_DEV_DOMAIN ?? "", ...(env.REPLIT_DOMAINS ?? "").split(",")];
  for (const entry of hosts) {
    const host = entry.trim();
    // Runtime values are hostnames, not URLs, wildcards, paths, or credentials.
    if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) continue;
    try {
      origins.add(new URL(`https://${host}`).origin);
    } catch {
      // Invalid runtime metadata must not broaden the allowlist.
    }
  }
  return origins;
}