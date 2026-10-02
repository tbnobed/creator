---
name: Long-form worker compatibility
description: Prevents long-form projects appearing to run while no shot can be dispatched.
---

Dispatch must require an online worker with normalized matching tags, free render capacity, and an active workflow whose node classes and model files are present. Model-family tags must be capability-gated; GPU class alone must never grant them.

**Why:** Existing worker rows can retain legacy tag names or casing across upgrades, and `/system_stats` can report a healthy high-memory GPU even while `/object_info` lacks a required custom loader or model filename. Premature tags turn a safe incompatibility into a queued render failure.

**How to apply:** Normalize configured tags during idempotent seeding, but add model-family tags only after probing every required node class and installed filename. Compare tags case-insensitively and log whether dispatch is waiting on a workflow, capability, or free slot.

Worker installation and application-deployment readiness are separate claims. A successful SSH installation plus development-database registration does not establish readiness in the user's Docker deployment.

**Why:** The same GPU workers serve independently configured application databases. Previously, all image models passed real worker tests but remained unavailable in Docker because only development capability tags had been updated.

**How to apply:** Verify capability registration in the application environment the user actually uses. State explicitly when Docker-side configuration is still required; never present development-only configuration as a deployed fix.

Treat execution success, media integrity, and visual correctness as separate validation gates.

**Why:** Controlled dual-H100 Wan runs completed without execution errors and produced correctly sized, fully decodable MP4s, yet inspected frames were severely distorted at both reduced and original sampling-step counts. Nonzero pixel variance and a success history do not establish usable output.

**How to apply:** Inspect generated frames before approving capabilities or automatic dispatch. Record codec checks and visual acceptance separately; do not turn a short thermal smoke-test pass into a quality or sustained-capacity claim.

Comfy V3 autogrowing inputs must be validated against their expanded names, not only their parent input name.

**Why:** Live metadata advertises a required `values` input for math expressions, while valid Wan and LTX graphs supply `values.a` and `values.b`. A naive required-key check falsely reports those working graph nodes as incomplete.

**How to apply:** Recognize `COMFY_AUTOGROW_V3` metadata when checking workflow inputs. Keep this exception separate from strict node-class and selectable-model filename checks.