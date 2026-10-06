---
name: Image Studio selection and limits
description: Avoid unintended paid model switching and distinguish app safeguards from native model limits.
---

Each Image Studio mode must remember its own model. Returning to Generate must not inherit a paid model selected by another mode; paid submission always needs explicit cost confirmation.

**Why:** The operator reported that browsing editing tools silently changed Generate from local FLUX to paid Nano Banana.

**How to apply:** Treat model choice as mode-specific state and validate readiness in both the button state and server submission path. Test a full round trip through every mode without submitting jobs.

Describe conservative single-pass video and image download safeguards as app limits, not proven universal model limits.

**Why:** Local workflow duration depends on frame rate, graph, and hardware; a cloud image's encoded download size also varies with content. Increasing an output download allowance alone does not prevent oversized paid submissions.

**How to apply:** Keep UI and backend limits aligned, reject oversized inputs before spending, and distinguish mock/provider-contract tests from actual inference. Do not replay failed paid jobs without authorization.

Masks are internal editing inputs, not gallery artwork. Hide them without deleting files or breaking saved-job references.

**Why:** The operator explicitly requested that black-and-white inpaint/outpaint masks stop appearing beside normal images.

**How to apply:** Keep masks out of gallery and search results, including previously saved masks, while retaining them for generation and job reuse.
