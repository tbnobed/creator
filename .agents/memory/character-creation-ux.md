---
name: Prompt-first character creation
description: Character creation must not require completing a dossier before generating.
---

Let users generate a character directly from a prompt. Casting notes, wardrobe, voice, and other dossier details are optional advanced work, not prerequisites.

**Why:** The user explicitly objected to the dossier-first interface and asked why they could not simply generate a character via prompt.

**How to apply:** Keep the initial creation flow prompt-first and preserve the existing detailed editor as an optional path. Do not silently introduce paid model defaults.

The standalone character generator should work like the Long-Form character generator.

**Why:** The user explicitly requested consistent behavior rather than separate creation experiences.

**How to apply:** Keep model choices, four portrait options, selecting the kept look, and reference-sheet generation consistent. Both flows must save usable shared-library characters; closing a dialog must not prevent generated references from being attached.

Publish project character assets additively, without repeatedly restoring library content the creator edited or deleted. A locked look is not approval of the whole dossier.

**Why:** Shared characters can outlive and serve multiple projects; replaying project snapshots would undo library decisions. Generated views can also miss the requested angle or clothing even when generation completes.

**How to apply:** Repair missing library links without regenerating images, preserve subsequent edits, and leave full dossier approval explicit. Treat requested view names as instructions, not verified image classifications.
