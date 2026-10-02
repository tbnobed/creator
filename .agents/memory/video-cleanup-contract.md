---
name: Video Cleanup scope and provider contract
description: Camera support, short-shot point tracking, audio preservation and local spending allowance.
---

The user requested Video Cleanup for both moving and stationary cameras, including removal of physical studio lights.

**Why:** The user explicitly chose both camera types rather than a locked-off-only workflow.

**How to apply:** Do not replace tracked object removal with a static background patch for moving footage. Camera mode is descriptive; both modes use the same temporal object-removal engine.

Bria's point-guided video eraser is a short-shot cloud workflow, not unrestricted long-video editing. Its documented input must be shorter than five seconds. Points mark objects on the first frame; they are not a user-painted or previewed segmentation mask.

**Why:** Fal's documented Bria input defaults to automatic five-second trimming, which could silently discard the rest of a user's clip. Whole-shot segmentation and visual correctness require provider inference and cannot be established with mocked lifecycle tests.

**How to apply:** Reject oversized durations before paid submission, explicitly disable automatic trimming, preserve original source audio during finalization, and describe provider-quality verification separately from lifecycle tests.

The five-dollar per-cleanup local budget reservation is a conservative application allowance, not a verified provider price or provider-enforced charge cap.

**Why:** The existing application tracks spending locally; no provider billing integration or live pricing lookup was authorized.

**How to apply:** Keep that distinction visible before paid confirmation. Do not present the allowance as an actual invoice or silently substitute live billing access.

Validate phone-video orientation using the actual display matrix rather than assuming a rotation metadata assignment worked.

**Why:** The workspace FFmpeg accepted the older rotate-metadata command without embedding rotation, producing a misleading unrotated test fixture. Display-matrix rotation and pixel dimensions can differ.

**How to apply:** Probe generated rotation fixtures before testing coordinate conversion; use FFmpeg's display-rotation option when supported, and verify the normalized output has upright pixels with no remaining rotation.