---
name: Structured long-form scripts
description: Planning behavior for scripts authored as explicit shot and B-roll blocks.
---

When a long-form script contains `SHOT <number>` or `B-ROLL <number>` headings, including labels separated by a colon or dash, preserve each labeled block as one planned shot in source order. Keep B-roll dialogue empty and extract quoted dialogue only from spoken shot blocks. Use the prose segmentation planner only for scripts without structured headers.

**Why:** Creator-authored shot lists already encode editorial intent, shot type, and ordering. Re-chunking them by an average duration destroys the prescribed coverage and interleaves dialogue with unrelated B-roll.

**How to apply:** Put the complete shot list in the Full Script field and reserve Visual Storyline for global continuity instructions. Preserve explicit authored durations; distribute the target only when durations are not supplied. Treat production-script narration, typography, and music explicitly intended for post as separate from generated dialogue and visuals.

Never describe a script as production-ready based only on its exported text: the destination importer and form requirements must support that format.

**Why:** A structurally valid export did not prevent an older destination importer from splitting a closing shot into sentence fragments. Workspace fixes do not establish that a separate production instance has those fixes.

**How to apply:** Verify the complete original script against the importer, including headings, durations, and style-prefix expansion, and state the production-update requirement separately.