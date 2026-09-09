import json
import sys

import torch
import torchaudio
from chatterbox.tts_turbo import ChatterboxTurboTTS


def main():
    request_path, reference_path, output_path = sys.argv[1:4]
    with open(request_path, "r", encoding="utf-8") as request_file:
        request = json.load(request_file)

    seed = int(request.get("seed", 0))
    if seed:
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)

    model = ChatterboxTurboTTS.from_pretrained(device="cuda")
    waveform = model.generate(
        request["text"],
        audio_prompt_path=reference_path,
    )
    torchaudio.save(output_path, waveform.cpu(), model.sr)


if __name__ == "__main__":
    main()