import json
import os
import subprocess
import tempfile
import wave

import numpy
import torch


class OBTVChatterboxTurbo:
    CATEGORY = "audio/tts"
    FUNCTION = "generate"
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True}),
                "reference_audio": ("AUDIO",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2147483647}),
            }
        }

    def generate(self, text, reference_audio, seed):
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("Dialogue is required")

        python = os.environ.get(
            "OBTV_CHATTERBOX_PYTHON",
            os.path.expanduser("~/obtv-chatterbox-venv/bin/python"),
        )
        runtime = os.path.join(os.path.dirname(__file__), "voice_runtime.py")
        with tempfile.TemporaryDirectory(prefix="obtv-chatterbox-") as directory:
            reference_path = os.path.join(directory, "reference.wav")
            output_path = os.path.join(directory, "speech.wav")
            request_path = os.path.join(directory, "request.json")

            waveform = reference_audio["waveform"].detach().cpu().float()
            if waveform.ndim == 3:
                waveform = waveform[0]
            pcm = (
                waveform.clamp(-1, 1)
                .mul(32767)
                .round()
                .to(torch.int16)
                .transpose(0, 1)
                .contiguous()
                .numpy()
            )
            with wave.open(reference_path, "wb") as reference_file:
                reference_file.setnchannels(pcm.shape[1])
                reference_file.setsampwidth(2)
                reference_file.setframerate(int(reference_audio["sample_rate"]))
                reference_file.writeframes(pcm.tobytes())
            with open(request_path, "w", encoding="utf-8") as request_file:
                json.dump({"text": clean_text, "seed": int(seed)}, request_file)

            result = subprocess.run(
                [python, runtime, request_path, reference_path, output_path],
                capture_output=True,
                text=True,
                timeout=900,
                check=False,
            )
            if result.returncode != 0:
                message = (result.stderr or result.stdout or "Unknown voice runtime error").strip()
                raise RuntimeError(f"Chatterbox Turbo failed: {message[-2000:]}")

            with wave.open(output_path, "rb") as output_file:
                channels = output_file.getnchannels()
                sample_rate = output_file.getframerate()
                if output_file.getsampwidth() != 2:
                    raise RuntimeError("Voice runtime returned an unsupported WAV format")
                generated = numpy.frombuffer(
                    output_file.readframes(output_file.getnframes()),
                    dtype="<i2",
                ).reshape(-1, channels)
            return ({
                "waveform": torch.from_numpy(
                    generated.astype(numpy.float32).transpose() / 32768.0
                ).unsqueeze(0),
                "sample_rate": sample_rate,
            },)