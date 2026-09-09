---
name: Comfy audio handoff
description: Compatibility rule for moving audio between Comfy custom nodes and isolated model runtimes.
---

Use Python's built-in WAV support plus NumPy tensors for PCM audio exchanged between Comfy custom nodes and isolated inference runtimes. Do not assume Comfy's `torchaudio.save` or `torchaudio.load` works without TorchCodec.

**Why:** The GPU workers can run newer Comfy Torch/Torchaudio builds where basic save operations require an additional TorchCodec package. Installing that package into Comfy would weaken the isolation intended to protect existing video workflows.

**How to apply:** Keep the Comfy-side handoff as 16-bit PCM WAV and let the isolated model environment use its own pinned audio stack. Verify both read and write paths on every distinct worker image before adding a scheduler capability tag.