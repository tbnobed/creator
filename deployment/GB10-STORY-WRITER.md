# GB10 screenplay writer

## Host and existing service

The operator confirmed GB10 access through `76.219.194.165:225`.
Use the existing Blackwell SSH secret entries; never put credentials in this file.
Hardware identification reports NVIDIA GB10, ARM64, hostname `gx10-28e4`.
This is not the separate RTX PRO 6000 / RTX 5090 worker.

The host already runs `snap.ollama.listener.service` on port 11434.
There is no need to install another Ollama instance or restart ComfyUI.
The installed general-purpose model selected for writing is
`qwen3.8:27b-q8_0` (the host's exact model tag, approximately 30 GB of weights).
The service reports the `thinking` capability; writing disables thinking so
the output budget produces screenplay JSON instead of a hidden reasoning trace.

## Production configuration

The operator confirmed that the production system can reach GB10 on its
internal network. The compose API service now defaults to these values;
the deployment environment can override them if needed:

```dotenv
STORY_AI_BASE_URL=http://192.168.0.114:11434
STORY_AI_COMFY_BASE_URL=http://192.168.0.114:8188
STORY_AI_MODEL=qwen3.8:27b-q8_0
```

Deploy the updated API and frontend together:

```sh
docker compose up -d --build api web
```

No SSH tunnel container or SSH credentials are needed by the API.
The interface reports a DHCP lease: ensure the private address is reserved,
or override the URLs with stable private DNS.
The API container must be able to reach both endpoints. These are not public
internet URLs and are not claimed to be reachable from every deployment.

Verify from the actual API container/network:

```sh
curl --fail --max-time 5 "$STORY_AI_BASE_URL/api/tags"
curl --fail --max-time 5 "$STORY_AI_COMFY_BASE_URL/queue"
```

Do not open unauthenticated Ollama port 11434 to the internet. If the API
server is on a different private network, use a private authenticated route
or tunnel under the production server's service manager.

The existing `PROMPT_AI_BASE_URL` and `PROMPT_AI_MODEL` remain the separate
CPU prompt checker. Script writing never silently falls back to them.
The application does not download missing models automatically.

## Shared-GPU behavior

- Video work takes priority. Running or queued ComfyUI work defers writing.
- A different resident Ollama model also defers writing instead of evicting it.
- Free GPU memory must cover 1.2 times the installed model's weight size plus
  8 GiB of headroom before loading.
- A warm-up must show nonzero GPU residency for the exact selected model.
  CPU-only inference is refused before submitting story content.
- During writing, the video queue is checked every two seconds. A new video
  job cancels the writing request, unloads its model and requeues that stage.
  Loss of the workload monitor stops writing with an explicit error.
- The model is unloaded after each writing stage, including failures.
- This cooperative monitor does not provide an atomic reservation against
  unrelated applications starting allocations between checks. Do not treat
  it as proof that arbitrary simultaneous GPU jobs are safe.
- No ComfyUI service restart, cache unload, job cancellation or intake change
  is performed by the writer.

## Explicit live smoke test

`scripts/verify-gb10-writer.mts --live` exercises the real scene-drafting and
shot-expansion functions, verifies GPU residency and checks model cleanup.
It requires all three `STORY_AI_*` variables and network access to the host.
It does not submit a video render or call a paid provider. Fictional draft
output is written only to `/tmp/gb10-story-writer-proof.json`.

For development-only verification, an SSH local forward can provide the two
private endpoints. Such a temporary forward is not a production deployment;
do not put a short-lived localhost tunnel address into production settings.
