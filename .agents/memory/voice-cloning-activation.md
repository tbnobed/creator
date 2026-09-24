---
name: Voice cloning activation
description: Defines when OBTV may synthesize and replace generated speech with a Character voice.
---

Voice cloning must be explicitly selected by the user for each generation. Selecting a Character, entering dialogue, or choosing a cloud model must not enable cloned-voice replacement implicitly.

Provider-native Seedance audio is a separate choice: audible speech may be requested without cloning a Character voice. Treat native speech as an attempt, not a promise of exact words, voice identity, or lip sync.

**Why:** The user requires voice cloning to remain optional rather than becoming the default behavior for generated videos. A request for audible dialogue does not grant consent to clone a Character voice.

**How to apply:** Default voice cloning controls to off, submit an explicit request flag, and preserve provider or source audio unless the user enables cloning and the existing consent requirements are satisfied. Keep native-audio controls and disclosures distinct from voice cloning.