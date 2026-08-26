---
name: Installable mobile workspace
description: PWA behavior and mobile-install support for the CreatorAi workspace.
---

The CreatorAi workspace is an installable PWA with a scoped service worker, manifest, platform icons, and in-app install guidance. The service worker may cache the app shell for offline recovery but must not cache API responses, because job progress and render status need to remain live.

**Why:** A stale cached queue can misleadingly show an old render state when a creator relies on the phone tracker.

**How to apply:** Preserve the base-path-aware service-worker registration and manifest scope. Use the browser's native install prompt where available; otherwise show iOS Share → Add to Home Screen, Android Install app/Add to Home screen, or Chrome install-menu guidance.