---
name: Preview authentication verification
description: Why browser authentication mutations must be checked through the public HTTPS preview.
---

Verify authentication mutations from the actual HTTPS preview origin, not only from localhost or a browser populated with a synthetic session.

**Why:** Localhost regression tests passed while real creator signup was blocked by origin validation behind the preview proxy. Rendering the signup page successfully did not prove its POST request could reach account validation.

**How to apply:** Include a browser-origin mutation and an unrelated-origin rejection check. Use invalid registration data to test transport without consuming the first-administrator slot or assigning existing workspace content to a disposable test account. Keep development origin allowances separate from production rules.