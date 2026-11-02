---
name: Long-form continuity contract
description: Approval and model-capability boundaries for long-form character continuity.
---

The user requires: "do not hardcode anything about the characters, ever."

**Why:** The user explicitly prohibited character-specific assumptions after invented anatomy contaminated diagnostic prompts.

**How to apply:** Obtain identities, appearance, actions and reference assignments from the actual production inputs. Do not encode this production's names, species, anatomy or staging into reusable logic or diagnostic scenarios. Use generic fixtures for regression tests; do not treat fabricated character descriptions as evidence of visual verification.

Treat an approved shot still and assigned wardrobe imagery as required render inputs, not optional prompt suggestions. Canonical character references may use remaining capacity; required imagery must not be silently discarded.

**Why:** A workflow can accept one reference yet lack space for wardrobe references. Advertising continuity in that case would hide that a creator's approved constraint never reached the model.

**How to apply:** Check the selected workflow's actual reference capacity before dispatch. Preserve per-job reference and speaker snapshots rather than relying on mutable project settings or shared state between GPUs.

An empty or mismatched scene cast list must not silently turn a named production character into a text-only subject.

**Why:** A scene described Cleo, but the opening prompt used the no-matched-cast fallback and omitted her approved image. The resulting subject did not match the creator's main character.

**How to apply:** Resolve known character mentions consistently for composed openings and video dispatch. Accept only exact names or unambiguous short names, fail on missing declared identities and ambiguous names, and preserve approved wardrobe precedence. Do not assume that a reference being included guarantees the model will reproduce it.

When the first view explicitly names its subjects, an opening composition uses those subjects rather than the union of characters appearing later in the scene. Keep the full scene cast for scene-level rendering; legacy unnamed group views retain their declared scene cast.

**Why:** The opening text could describe only Cleo while references included other scene characters. The user showed an output blending Cleo's accessories with Ridley's bird features; the actual submitted inputs for that external render were unavailable, so reference contamination remained a suspected cause, not a verified diagnosis.

**How to apply:** Bind each included reference image to its named character and preserve species, anatomy and approved wardrobe. Test single-character openings in multi-character scenes as well as explicitly multi-character openings.

Use the delivered image's embedded workflow to establish which generation produced it; do not assume a neighboring diagnostic history file belongs to the same rerun.

**Why:** A saved diagnostic PNG contained the newer separate-crop/segmentation workflow, while its neighboring history JSON still described an earlier shared-sampler workflow and obsolete anatomy prose.

**How to apply:** Match the user's image to the saved output, inspect its embedded prompt graph, and compare that graph with the actual app job before attributing a visual difference to code or settings.

The separate-crop compositor is not an identity- or composition-verified solution. Group corrections must re-use approved identities, not a blended prior image as their only reference.

**Why:** Shared sampling transferred features between subjects. The creator subsequently rejected the separate-sampler sample: it replaced the approved spotted, upright character with a shark. The diagnostic had incorrectly supplied a shark description, contradicting the portrait. Removing that prose restored a closer character in a later sample, but it still floated above the water. A full-frame sequential-edit alternative also changed anatomy. Neither approach has passed visual acceptance.

**How to apply:** Make the locked image authoritative over character-creation prose. Preserve approval gates and explicit reference-capacity failures. Compare every generated character against its actual portrait, including anatomy and accessories, and inspect scale and ground contact before claiming a visual fix.

Do not paste a whole generated character crop into approved scenery, even with a feathered rectangular edge. Segment only the generated subject and its visible reflection/contact details; retain the original scenery outside that mask, and fail explicitly if a required mask is empty, implausibly broad or unsupported by the selected worker.

Masking preserves scenery; it does not establish that a generated subject belongs in the scene or matches its approved identity.

Creators must be able to queue multiple opening-image alternatives and approve an older version made from still-current production inputs. New generations must not replace an existing approval.

**Why:** The user explicitly requested simultaneous alternatives and the ability to choose earlier results, rather than being forced to approve only the latest generation.

**How to apply:** Keep version history and approval separate from job progress. Preserve previews of stale results without permitting them to bypass changed cast, wardrobe, scene or location requirements.

**Why:** An approved multi-character scene acquired a vertical sky seam where separately generated crops met. The first subject-only mask removed that seam but also removed a character's water reflection; a separate reflection mask restored that contact detail in the live local test.

**How to apply:** Check worker nodes and model files before assignment, not only at submission. Verify both scene-background continuity and contact details on real GPU output; do not infer visual success from graph structure or unit tests alone. Earlier generated images do not repair themselves and need a new approved opening.

Revising a completed continuity-controlled shot must leave time for review before rendering again.

**Why:** The ordinary edit-and-regenerate flow conflicts with a required still-approval stage. Continuity revisions need a deliberate paused review state, while existing projects without continuity retain their original behavior.

**How to apply:** Keep destructive revision actions explicit, preserve unrelated completed shots, and require a current approval before resuming. Voice cloning remains a separate explicit per-shot opt-in.

Reusable character dossiers are a source for explicitly imported production settings, not live-linked replacements for project continuity.

**Why:** Updating a cast-library wardrobe must not unexpectedly change an ongoing production's approved look. Dossier approval is advisory for legacy character use, separate from shot-still approval.

**How to apply:** Import approved dossier data only by producer action, confirm replacements, and retain project-owned snapshots. Describe text-only reference generation honestly; a saved primary image does not mean every image workflow consumes it.

The user requires exact starting-frame continuation, not the previous frame supplied merely as a visual reference.

**Why:** The user explicitly chose exact first-frame continuation when H3 REF2VA could not provide it.

**How to apply:** Do not alias H3 reference images as first frames. A workflow must consume a true starting-frame input without displacing mandatory cast/scenery references; otherwise it needs an approved composed-frame stage before animation.

Do not silently brighten or replace the continuation frame to hide cumulative exposure drift.

**Why:** The creator reported progressively darkening shots, but exact first-frame continuity remains an explicit requirement. Automatic grading of the handed-off image would change that contract rather than prove a lighting fix.

**How to apply:** Keep the approved scene lighting as the baseline. Detect severe unintended drift and request correction before propagating it; distinguish those guardrails from a verified model-level cure and preserve intentional lighting changes.

When the user requests Long-Form verification, test a visible application project through its actual steps, not only a direct ComfyUI submission.

**Why:** The user repeatedly requested end-to-end verification and rejected a standalone worker diagnostic as evidence that their project works.

**How to apply:** Keep worker diagnostics explicitly separate. Verify story drafting, saved project assets, render submission, continuation, review and export through the application; report the first blocked step without claiming completion.

Long-Form end-to-end verification must include multiple scenes, not just multiple shots in a single scene.

**Why:** The user explicitly required multiple scenes when the initial verification project had only one.

**How to apply:** Include distinct locations and carry cast/wardrobe across them; inspect within-scene continuation, scene transitions and final assembly.

Individual shots must be playable beside their correction controls; the assembled Review video is not a substitute.

**Why:** The user repeatedly requested shot previews to decide corrections, not instructions to watch the whole export.

**How to apply:** Keep shot playback accessible in both Create and manual Review corrections, without triggering a new render.

Project-content removal must not delete shared-library assets or historical rendered media. Structural edits require a fresh render plan.

**Why:** The user needs to edit and remove scenes, characters, wardrobe and places without destroying reusable assets or making old shot mappings appear current.

**How to apply:** Update dependencies and scene ranges, retain prior renders in history, and block changes while image generation or individual shots are still active.

Native H3 guide conditioning is not proof of exact first-frame preservation or cross-scene visual continuity.

**Why:** Live multi-scene verification produced playable exports but changed clothing, prop scale and appearance; decoded adjacent boundary frames were not identical.

**How to apply:** Separate pipeline completion from visual acceptance. Verify generated reference images and scene-opening compositions before rendering, then inspect boundary frames and cross-scene identity; never label a successful job as verified continuity.

An approved dressed character reference takes precedence over its original unclothed portrait and shared-library wardrobe descriptions.

**Why:** Supplying both looks makes clothing ambiguous. Even when production explicitly supplies its approved images, spare workflow slots can otherwise reintroduce an older library look.

**How to apply:** Treat project-approved appearance and recurring-prop references as complete snapshots, not additions to an automatically chosen library appearance. Reference approval is input acceptance, not proof that generated video preserved the look; inspect output frames too.

Scene animation must start from a reviewed composition containing the intended cast, outfits and props in the actual location—not an empty room plus competing portrait backgrounds.

**Why:** A live scene transition began in the workshop but ended against the neutral character-reference backdrop. Reference boards also produced duplicate characters and oversized props; separate native reference inputs improved composition but still required correction and human review.

**How to apply:** Use separate native reference conditioning, fail rather than drop excess references, and require explicit approval of the composed opening. Bind approval to current source images, identity, scene and output dimensions. Never auto-approve a generated candidate or equate successful rendering with visual continuity.

Automatic scene-opening and correction instructions must be location-neutral. Interior or exterior details should come from the creator's scene and approved scenery, not a shared indoor template.

**Why:** An outdoor marsh opening repeatedly included an overhead structure while the shared template instructed every scene to be photographed “inside the room.” That wording was a confirmed prompt defect, not proof of the exact cause of every generated artifact.

**How to apply:** Preserve the reference location, scenery and lighting without inventing a room, roof, or ceiling. Test both outdoor and indoor scenes, retaining explicitly authored interior details.

A reviewed opening is necessary input validation, not a demonstrated cure for H3 background drift.

**Why:** A second live two-scene test used the approved composition, correct empty workshop and a cropped prop reference with library fallbacks disabled. The workshop still changed into a neutral backdrop during close-ups. The character and vest remained recognizable, but scenery continuity failed.

**How to apply:** Do not advertise this H3 path as fully continuity-verified. Preserve failed outputs for comparison and obtain a deliberate workflow/model decision rather than repeating the same render or silently charging for a paid alternative.

Stable-exposure prompt text and a bright opening guide do not guarantee stable lighting through an H3 clip. An exposure check is a cascade safeguard, not a demonstrated prevention mechanism.

**Why:** A user-supplied fading clip was byte-identical to a retained worker output. Its actual prompt prohibited dimming, and its starting guide matched the bright approved composition. A matched-input, matched-seed comparison retained a bright ending after the negated unwanted-effect descriptions were replaced with positive illumination instructions. This supports the prompt correction for that example, not universal stability or a quantization/decoder diagnosis.

**How to apply:** Use positive-only automatic lighting descriptions, preserve explicitly authored lighting changes, and retain the exposure safeguard. Inspect the actual submitted graph, input images and raw worker output before attributing fading to prompts, previous-frame inheritance, precision, or a specific GPU. Distinguish a measured comparison from an unproven general diagnosis.

Shot correction requires stopping a running queue, not requiring every project to transition from running to paused. Keep the ordinary manual Pause command strict.

**Why:** A creator could not re-render a completed shot in a failed production because the correction flow unconditionally invoked the running-only Pause operation.

**How to apply:** Treat already-stopped projects as ready for correction, preserve protections for active shots and final assembly, and validate lifecycle decisions under the project lock. Refresh the separate render-query cache after correction success or failure; otherwise a stopped parent's cached status can hide a newly active shot. Keep polling while any child shot is active, even if the parent is paused or failed.

Shots must support re-rendering without an explicit correction. Corrections are optional. Both local and paid re-renders require confirmation before submission.

**Why:** The user explicitly requested a new render without having to describe a change, and subsequently objected to re-rendering starting without confirmation.

**How to apply:** Provide a direct re-render action, preserve the authored prompt when no correction is supplied, and retain active-render guards and paid-provider confirmation. Do not invent correction text to satisfy a required field.

Multi-step shot corrections must finish preparing the selected shots before scheduling background dispatch.

**Why:** Early automatic dispatch can acquire the project lock before a later step of the same request, reporting failure even though rendering already started.

**How to apply:** Keep dispatch paused throughout batch preparation and start it once afterwards. Preserve automatic dispatch for standalone operations. Do not hide genuine errors or retry submissions to conceal lock conflicts.
