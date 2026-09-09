export function createChatterboxTurboWorkflow(input: {
  text: string;
  referenceAudioName: string;
  seed: number;
}): Record<string, unknown> {
  return {
    "1": {
      class_type: "LoadAudio",
      inputs: {
        audio: input.referenceAudioName,
      },
    },
    "2": {
      class_type: "OBTVChatterboxTurbo",
      inputs: {
        text: input.text,
        reference_audio: ["1", 0],
        seed: input.seed,
      },
    },
    "3": {
      class_type: "SaveAudio",
      inputs: {
        audio: ["2", 0],
        filename_prefix: "obtv_voice",
      },
    },
  };
}