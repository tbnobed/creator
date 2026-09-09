---
name: OpenAPI Zod compatibility
description: Codegen compatibility constraint in this workspace's generated validators.
---

OpenAPI integer, URI, and email formats currently produce Zod v4-only helpers through the installed Orval version, while the workspace's shared Zod dependency is v3. Model those values as numbers and plain strings in the generated contract, then enforce integer, URL, and email rules at the server boundary.

**Why:** The otherwise-valid API contract fails the shared library build because generated validators call unavailable `zod.int()`, `zod.url()`, and `zod.email()` helpers.

**How to apply:** Before using a new OpenAPI numeric, URL, or email constraint in this workspace, run codegen and the shared library typecheck; keep stronger runtime validation in the route or domain service until the workspace upgrades its Zod dependency.