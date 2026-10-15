const AUTH_CHANNEL = "obtv-auth";
const AUTH_EVENT_KEY = "obtv:auth-changed";
// BroadcastChannel excludes the sending channel object, not the whole tab.
// The publisher and subscriber are different objects in this same document.
const AUTH_SOURCE = crypto.randomUUID();

export function publishAuthChanged(): void {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage({ type: "changed", source: AUTH_SOURCE });
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
  const onMessage = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object" && event.data.source === AUTH_SOURCE) return;
    // Continue accepting legacy "changed" messages from older open tabs.
    onChange();
  };
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