---
name: Fal Seedance provider contract
description: Non-obvious differences between the comparison repository and Fal's Seedance API, plus private reference uploads.
---

Use Fal's published Seedance API as the executable contract when matching the creator's comparison repository, https://github.com/wide-trace/open-higgsfield. The repository's provider routes are not interchangeable with Fal's; Fal Seedance 2.5 uses the reference-to-video endpoint with a task field for reference, editing, or extension.

**Why:** Matching the repository's UI semantics while copying its platform-specific URLs would submit unsupported paid requests. Fal's Edit task chooses output duration automatically, so a creator-selected short duration cannot be used as the spending reservation. Reserve against the documented maximum and measure the actual output afterward.

**How to apply:** Check the current Fal API schema for the selected endpoint before adding a mode or media role. In particular, don't silently drop media that the chosen endpoint cannot accept. Validate limits and reserve spending before inference.

Keep tenant-private video/audio private when handing them to Fal. Fal CDN inputs are public-by-link unless the upload itself requests a restrictive ACL; model workers can fetch a bounded signed read URL rather than an anonymous public URL.

**Why:** A private workspace upload becoming a public CDN link violates the original tenant boundary even if the application does not display that link. Fal's direct-upload initiation may return a v3b.fal.media upload host, not just a cloud-storage hostname; a mock-only test missed this.

**How to apply:** Set a restrictive ACL on direct upload, sign a read-only URL for inference, and fail before paid submission if signing fails. Verify with synthetic media that an unsigned read is denied and a signed read works; do not test with tenant media or submit a paid render for this check.

Treat requested MOV as an output-container conversion, not a Fal model parameter.

**Why:** The comparison repository exposes MOV but Fal's checked schema does not. Remuxing a completed MP4 preserves encoded audio/video without another paid inference. A remux failure must retain the provider request and its spending state rather than generating again.

**How to apply:** Keep requested format in durable recovery metadata; retry local output finalization independently of paid generation. Test format, audio preservation, MIME, filename, and authenticated serving together.