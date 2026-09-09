const AUTH_CHANNEL = "obtv-auth";
const AUTH_EVENT_KEY = "obtv:auth-changed";

export function publishAuthChanged(): void {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage("changed");
      channel.close();
    }
    localStorage.setItem(AUTH_EVENT_KEY, crypto.randomUUID());
  } catch {
    // Authentication remains valid even when browser storage is unavailable.
  }
}

export function subscribeToAuthChanges(onChange: () => void): () => void {
  const channel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(AUTH_CHANNEL)
    : null;
  const onMessage = () => onChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTH_EVENT_KEY) onChange();
  };
  channel?.addEventListener("message", onMessage);
  window.addEventListener("storage", onStorage);
  return () => {
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
}