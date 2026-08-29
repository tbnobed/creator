---
name: Ollama Compose bootstrap
description: Non-obvious startup constraints for installing a local Ollama model in Docker Compose.
---

The official Ollama image has `ollama` as its entrypoint. A shell bootstrap placed only in `command` is therefore interpreted as an Ollama subcommand unless the entrypoint is explicitly replaced. With `/bin/sh -c`, Compose must pass the entire bootstrap as one command-array element; a scalar may be split so the shell executes only the first word.

**Why:** The original container entered a restart loop with `unknown command "/bin/sh" for "ollama"`. A later scalar command rendered as separate arguments, causing the shell to run only `ollama`. A one-shot pull that fails must also retry rather than silently leave the service model-less.

**How to apply:** When changing the local prompt-AI container, preserve the explicit shell entrypoint, one-element bootstrap command, local readiness loop, retrying model pull, and model-aware health check. Keep the Ollama server alive while retries occur.