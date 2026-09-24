---
name: Workspace test runner resolution
description: Why the frontend TypeScript unit tests need the artifact-local runner
---

For frontend TypeScript unit tests, use the artifact-local `tsx` executable rather than invoking Node's test runner directly or resolving `tsx` with `pnpm exec` at the workspace root.

**Why:** Node's native TypeScript stripping does not resolve this project's extensionless TypeScript imports, and the workspace root does not expose the artifact's local `tsx` executable through `pnpm exec`.

**How to apply:** When running the frontend's standalone TypeScript tests from the workspace root, resolve the test runner within that artifact's `node_modules/.bin` and pass its test files to `tsx --test`. This does not require changing packages.