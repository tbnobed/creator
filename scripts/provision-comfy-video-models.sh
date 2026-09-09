#!/usr/bin/env bash
set -euo pipefail

COMFYUI_DIR="${COMFYUI_DIR:-}"
MODEL_SET="${MODEL_SET:-all}"

if [[ -z "$COMFYUI_DIR" || ! -d "$COMFYUI_DIR/models" ]]; then
  echo "Set COMFYUI_DIR to the ComfyUI installation directory." >&2
  exit 1
fi

if [[ -z "${COMFY_PYTHON:-}" ]]; then
  if [[ -x "$COMFYUI_DIR/venv/bin/python" ]]; then
    COMFY_PYTHON="$COMFYUI_DIR/venv/bin/python"
  elif [[ -x "$COMFYUI_DIR/.venv/bin/python" ]]; then
    COMFY_PYTHON="$COMFYUI_DIR/.venv/bin/python"
  else
    COMFY_PYTHON="python3"
  fi
fi

download() {
  local url="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  if [[ -s "$destination" ]]; then
    echo "Already present: $destination"
    return
  fi
  local args=(--fail --location --retry 5 --retry-delay 5 --continue-at - --output "$destination.part")
  echo "Downloading $(basename "$destination")"
  if [[ -n "${HF_TOKEN:-}" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$HF_TOKEN" |
      curl "${args[@]}" --config - "$url"
  else
    curl "${args[@]}" "$url"
  fi
  mv "$destination.part" "$destination"
}

install_wan() {
  local wan22_revision="c4f60d30c55a624e35427060fdd217579a6c1d77"
  local wan21_revision="617a7633e636506f850e043bc4605f290a466a8e"
  download \
    "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/${wan22_revision}/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" \
    "$COMFYUI_DIR/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
  download \
    "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/${wan21_revision}/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" \
    "$COMFYUI_DIR/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
  download \
    "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/${wan22_revision}/split_files/vae/wan2.2_vae.safetensors" \
    "$COMFYUI_DIR/models/vae/wan2.2_vae.safetensors"
}

install_ltx() {
  local gguf_revision="7b0c2025441f1bf12c18eac375ad21f5e3d3c9e0"
  local ltx_revision="5e6e71018ee1756ed329b697a7b4aedc934dfce9"
  local gguf_dir="$COMFYUI_DIR/custom_nodes/ComfyUI-GGUF"
  if [[ ! -d "$gguf_dir/.git" ]]; then
    git clone https://github.com/city96/ComfyUI-GGUF.git "$gguf_dir"
  fi
  git -C "$gguf_dir" fetch --all --tags
  git -C "$gguf_dir" checkout --detach 6ea2651e7df66d7585f6ffee804b20e92fb38b8a
  "$COMFY_PYTHON" -m pip install -r "$gguf_dir/requirements.txt"

  download \
    "https://huggingface.co/Abiray/LTX-2.5-Distilled-GGUF/resolve/${gguf_revision}/LTX-2.5-Distilled-Q6_K.gguf" \
    "$COMFYUI_DIR/models/diffusion_models/LTX-2.5-Distilled-Q6_K.gguf"
  download \
    "https://huggingface.co/Lightricks/LTX-2.5/resolve/${ltx_revision}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors" \
    "$COMFYUI_DIR/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
  download \
    "https://huggingface.co/Lightricks/LTX-2.5/resolve/${ltx_revision}/vae/ltx-2.5-video-vae-bf16.safetensors" \
    "$COMFYUI_DIR/models/vae/ltx-2.5-video-vae-bf16.safetensors"
  download \
    "https://huggingface.co/Lightricks/LTX-2.5/resolve/${ltx_revision}/vae/ltx-2.5-audio-vae-bf16.safetensors" \
    "$COMFYUI_DIR/models/vae/ltx-2.5-audio-vae-bf16.safetensors"
  download \
    "https://huggingface.co/Lightricks/LTX-2.5/resolve/${ltx_revision}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" \
    "$COMFYUI_DIR/models/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
}

install_flux2_klein() {
  local klein_revision="5f526678002e43af5551dadb73ce2e8c91b43afe"
  local flux2_revision="ab9055628ea245000e610f2aa2c96f4746093546"
  download \
    "https://huggingface.co/Comfy-Org/flux2-klein/resolve/${klein_revision}/split_files/diffusion_models/flux-2-klein-4b.safetensors" \
    "$COMFYUI_DIR/models/diffusion_models/flux-2-klein-4b.safetensors"
  download \
    "https://huggingface.co/Comfy-Org/flux2-klein/resolve/${klein_revision}/split_files/text_encoders/qwen_3_4b.safetensors" \
    "$COMFYUI_DIR/models/text_encoders/qwen_3_4b.safetensors"
  download \
    "https://huggingface.co/Comfy-Org/flux2-dev/resolve/${flux2_revision}/split_files/vae/flux2-vae.safetensors" \
    "$COMFYUI_DIR/models/vae/flux2-vae.safetensors"
}

case "$MODEL_SET" in
  all)
    install_wan
    install_ltx
    install_flux2_klein
    ;;
  wan)
    install_wan
    ;;
  ltx)
    install_ltx
    ;;
  flux2-klein)
    install_flux2_klein
    ;;
  *)
    echo "MODEL_SET must be one of: all, wan, ltx, flux2-klein" >&2
    exit 1
    ;;
esac

echo
echo "Provisioning complete. Restart ComfyUI, verify /object_info, then add worker tags:"
echo "  wan-2.2"
echo "  ltx-2.5"
echo "  flux2-klein"