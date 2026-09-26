# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## External repository for comparison

- The creator's specified comparison repository is **https://github.com/wide-trace/open-higgsfield**. When asked to compare "the repo" with this app, inspect that repository rather than assuming "repo" means this workspace or its Git remote.

## User preferences

- The UI must call the external provider **Cloud**, never fal.ai; API errors shown in the UI follow the same branding. Keep internal provider IDs, enum values, endpoint URLs, credential keys, and technical documentation unchanged.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## GPU worker access

These SSH connection details were confirmed by the operator. Keep them available for future worker maintenance; do not ask the operator to supply them again.

- **A100:** `ssh ubuntu@107.180.212.240 -p 225` — password supplied through `GPU_A100_SSH_PASSWORD`.
- **H100:** `ssh ubuntu@107.180.212.240 -p 226` — password supplied through `GPU_H100_SSH_PASSWORD`.
- SSH inspection confirmed `/home/ubuntu/ComfyUI` on port 225 (runs as `ubuntu`) and `/opt/ComfyUI` on port 226 (systemd `comfyui.service`, runs as `comfyui`, models in `/srv/comfyui/models`).
- Both machines reported **NVIDIA A100 80GB PCIe** during SSH verification on 2026-09-10; “H100” remains the operator's label for port 226, not a verified hardware specification.
- Passwords and Hugging Face credentials belong only in workspace secrets, never in files or logs.
- Check the actual GPU, ComfyUI process, model directory, and active queue on each SSH host before maintenance. App display labels and API port mappings alone are not proof of worker identity.
- Preserve existing video/voice workloads and Python environments; do not restart an occupied worker.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
