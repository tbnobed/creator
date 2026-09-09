---
name: Comfy audio handoff
description: Compatibility rule for moving audio between Comfy custom nodes and isolated model runtimes.
---

Use Python's built-in WAV support plus NumPy tensors for PCM audio exchanged between Comfy custom nodes and isolated inference runtimes. Do not assume Comfy's `torchaudio.save` or `torchaudio.load` works without TorchCodec.

**Why:** The GPU workers can run newer Comfy Torch/Torchaudio builds where basic save operations require an additional TorchCodec package. Installing that package into Comfy would weaken the isolation intended to protect existing video workflows.

**How to apply:** Keep the Comfy-side handoff as 16-bit PCM WAV and let the isolated model environment use its own pinned audio stack. Verify both read and write paths on every distinct worker image before adding a scheduler capability tag.

Application-side audio/video muxing must use an OS-provided temporary directory, never a path relative to the application working directory.

**Why:** Production containers run as an unprivileged user with a writable media volume but a non-writable application tree. A relative mux path worked in development and failed with a permissions error only in Docker.

**How to apply:** Create a unique directory under the operating system temp root for each mux operation, clean up the directory in a `finally` block, and verify the flow from a non-writable working directory.