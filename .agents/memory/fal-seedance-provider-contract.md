---
name: Fal Seedance provider contract
description: Non-obvious differences between the comparison repository and Fal's Seedance API, plus private reference uploads.
---

Use Fal's published Seedance API as the executable contract when matching the creator's comparison repository, https://github.com/wide-trace/open-higgsfield. The repository's provider routes are not interchangeable with Fal's; Fal Seedance 2.5 uses the reference-to-video endpoint with a task field for reference, editing, or extension.

**Why:** Matching the repository's UI semantics while copying its platform-specific URLs would submit unsupported paid requests. Fal's Edit task chooses output duration automatically, so a creator-selected short duration cannot be used as the spending reservation. Reserve against the documented maximum and measure the actual output afterward.

**How to apply:** Check the current Fal API schema for the selected endpoint before adding a mode or media role. In particular, don't silently drop media that the chosen endpoint cannot accept. Validate limits and reserve spending before inference.

Resolve disputed provider capabilities from the exact operation's raw Fal OpenAPI, not similarly named types on the model documentation page.

**Why:** The documentation pages mix model variants. Repeated page-based audits wrongly excluded Veo Fast 4K while its exact Fast request schemas included it; a similar confusion made optional Kling element angles appear required.

**How to apply:** Fetch `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<exact endpoint>`, follow the POST request body's `$ref`, and inspect that schema's enums and required fields. Check each frame/reference route separately.

Keep tenant-private video/audio private when handing them to Fal. Fal CDN inputs are public-by-link unless the upload itself requests a restrictive ACL; model workers can fetch a bounded signed read URL rather than an anonymous public URL.

**Why:** A private workspace upload becoming a public CDN link violates the original tenant boundary even if the application does not display that link. Fal's direct-upload initiation may return a v3b.fal.media upload host, not just a cloud-storage hostname; a mock-only test missed this.

**How to apply:** Set a restrictive ACL on direct upload, sign a read-only URL for inference, and fail before paid submission if signing fails. Verify with synthetic media that an unsigned read is denied and a signed read works; do not test with tenant media or submit a paid render for this check.

For Seedance 2.5 editing, use private hosted image and video inputs with a read-access preflight, rather than mixing inline base64 images and hosted video.

**Why:** An approved edit returned the same unexplained upstream 422 with both inline-image and verified hosted-image inputs despite passing documented media limits. Uniform hosted inputs simplify access checks, but changing image transport did not resolve the rejection.

**How to apply:** Keep other working Seedance modes unchanged. Verify signed access before inference, and do not describe an upstream rejection as fixed until an explicitly approved real render succeeds. Do not spend on further image-transport variations as though they were an untested fix; establish a specific provider-contract discrepancy first.

Treat requested MOV as an output-container conversion, not a Fal model parameter.

**Why:** The comparison repository exposes MOV but Fal's checked schema does not. Remuxing a completed MP4 preserves encoded audio/video without another paid inference. A remux failure must retain the provider request and its spending state rather than generating again.

**How to apply:** Keep requested format in durable recovery metadata; retry local output finalization independently of paid generation. Test format, audio preservation, MIME, filename, and authenticated serving together.