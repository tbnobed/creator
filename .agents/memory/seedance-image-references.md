---
name: Seedance image references
description: Preserve the distinction between textual descriptions and actual image conditioning on Cloud video jobs.
---

When a creator selects character or setting images for a Seedance Cloud video, send actual private image data to a reference-capable endpoint and bind each image to its subject in the prompt. A text description alone is not reference conditioning. Do not silently downgrade selected images to text-only generation if the selected subject lacks a usable image or the model's image limit is exceeded.

**Why:** The composer accepted Maya and a studio, but a Seedance text-to-video request only contained their descriptions. The output could not use their photographs for identity or layout even though the selected assets appeared in the UI. A paid job that quietly drops selected references breaks creator expectations.

**How to apply:** Keep text-only endpoints for requests without selected assets. For image-backed requests, use the matching reference endpoint, private image transfer, stable positional image tags, corresponding model pricing and recovery identity, and an explicit error before provider submission when an asset cannot be supplied. Provider acceptance does not prove visual identity fidelity; only an output review can establish that.