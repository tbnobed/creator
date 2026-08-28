---
name: AI prompt review safety
description: Durable rules for optional AI-assisted prompt editing in OBTV CreatorAi.
---

AI-polished prompts must remain separate, editable drafts. Show every field that could change, let the creator choose which fields to apply, and invalidate the suggestion if the source fields change while it is pending or under review. Deterministic guidance must remain usable when AI is unavailable.

**Why:** Prompt assistance should preserve creator intent. Hidden or stale field replacement can erase authored camera, motion, dialogue, exclusion, or continuity direction.

**How to apply:** Any future prompt-polish, rewrite, optimization, or model-specific suggestion flow must use explicit review and acceptance rather than writing directly into render inputs.