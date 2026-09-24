---
name: Elevated sheet menus
description: Why dropdown controls inside OBTV setup sheets need explicit portal stacking
---

When a modal sheet uses a higher stacking layer than the shared Radix select/popover portals, opening a dropdown can place its choices behind the sheet and make subsequent controls appear unresponsive.

**Why:** The render-setup sheet was raised above the default portal layer; its menu options opened out of view despite valid change handlers. Browser interaction checks confirmed the options became clickable after raising the menus.

**How to apply:** For controls rendered inside elevated sheets, keep their portaled content above the sheet (or align the whole modal stack consistently). Test a real click on an option and a non-portal control such as a slider; static screenshots and type checks cannot catch this interaction failure.