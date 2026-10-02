# Local garment video proof — 2026-10-02

## Result

Models installed; local garment replacement demonstrated at draft resolution.
The generative monkey test did not achieve playing motion; a subsequent CPU
compositing proof (`animated-print.mp4`) demonstrates independently animated
printed monkeys with affine garment tracking. The in-app
workflow remains unconnected and must not be described as production-ready.

Both dual-H100 ComfyUI listeners expose the installed VACE 14B, Wan 2.1 VAE,
and SAM3.1 checkpoints. Installation uses pinned revisions and SHA-256 verification.
Tests ran sequentially on Worker 1 after an idle queue check. No paid provider,
worker restart, routing-tag change, or thermal-setting change was used.
Both worker queues were empty at the final read-only check.

## Inputs and outputs

- Source: original black-shirt clip, window 2.000–5.0625 seconds.
- Draft: 512×288, 16 fps, 49 frames, 3.0625 seconds.
- Garment reference: frame at 7 seconds from the supplied orange-shirt comparison.
- `comparison.mp4`: original and corrected garment replacement, side by side.
- `obtv-reference-cleared.mp4`: corrected reference-conditioned garment result.
- `obtv-monkeys-cleared.mp4`: artwork test, **not accepted as playing animation**.
- `mask.mp4`: diagnostic shirt segmentation/tracking.
- `garment-reference.png`: supplied example frame used for conditioning.
- JSON receipts retain the submitted graphs and worker execution history.

## Findings

The initial graph passed the original shirt into VACE's reactive conditioning.
It mostly recolored the polo; stronger text prompts did not solve replacement.
Comparing against the official ComfyUI video-inpainting blueprint exposed the
missing masked-region clearing step.

The corrected graph clears that region before VACE encoding, optionally adds
a reference image, trims reference latents, and composites the generated shirt
onto untouched source frames using the tracked mask. With the provided reference,
the result shows an orange button-front garment rather than the original polo.
The source face, surrounding scene and hand overlap appear retained in the sampled
frames. This is a short, low-resolution proof, not full-length temporal validation.

The corrected monkey test adds a colorful shirt graphic, but sampled frames do
not demonstrate monkeys actively playing. Generative artwork is not sufficient
evidence of controlled character animation. A separate tracked animation approach
still needs implementation and evaluation.

## Verification

- Corrected reference render: 50.777 seconds on the worker.
- Corrected artwork render: 48.928 seconds on the worker.
- Both outputs: 49 frames at 512×288, video duration 3.0625 seconds.
- Both outputs retain stereo source audio, duration 3.062 seconds.
- Decoded mono audio correlation versus prepared source: 0.999577 for both.
  Audio is AAC re-encoded, not bit-identical to the original PCM.
- Three graph tests pass, including mask clearing, original-source compositing,
  source-audio routing and reference-latent trimming.

## Remaining work

### Material-blending revision

The user rejected the first CPU print as superimposed. `fabric-print.mp4`
replaces rigid artwork placement with advected material coordinates from dense
bidirectionally checked optical flow, using validated affine motion only where
local flow is unreliable. Initial fold bending is estimated from image contrast;
it is **not recovered 3D cloth geometry**. Ink inherits broad source shadows and
fine texture, with matte color blending. The revised 49-frame proof passes
outside-mask pixel checks and five compositor/tracking tests. It remains a
low-resolution approximation, not an accepted production fabric effect.

The user selected moving printed artwork. The CPU proof has two original cartoon
monkeys hopping and waving with a bouncing ball. Its 49 frames tracked with at
least 82 robust feature inliers per transition; outside-mask pixels were verified
unchanged before encoding. Source audio is stream-copied. This uses affine motion
and local fabric shading, **not dense cloth deformation**. Larger movement,
wrinkles and occlusions require further validation.

Connect the
workbench to a tenant-scoped, recoverable local job pipeline. Add reference-image
selection and validate longer clips, higher resolution, occlusions and boundary
stability before enabling full-length processing.