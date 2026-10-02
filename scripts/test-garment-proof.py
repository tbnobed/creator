import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("garment", pathlib.Path(__file__).with_name("garment-proof.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GarmentGraphTests(unittest.TestCase):
    def test_control_erases_garment_before_vace_conditioning(self):
        graph = module.workflow("source.mp4", "test", "Orange button-down", target="jacket")
        self.assertEqual(graph["16"]["inputs"]["control_video"], ["26", 0])
        self.assertEqual(graph["26"]["inputs"]["mask"], ["6", 0])
        self.assertEqual(graph["26"]["inputs"]["source"], ["25", 0])
        self.assertEqual(graph["25"]["inputs"]["mask"], ["24", 0])
        self.assertEqual(graph["24"]["class_type"], "InvertMask")
        self.assertEqual(graph["20"]["inputs"]["destination"], ["2", 0])

    def test_reference_conditions_vace_without_replacing_source(self):
        graph = module.workflow("source.mp4", "test", "Orange button-down", reference="shirt.png", target="jacket")
        self.assertEqual(graph["16"]["inputs"]["reference_image"], ["23", 0])
        self.assertEqual(graph["23"]["inputs"]["image"], "shirt.png")
        self.assertEqual(graph["20"]["inputs"]["destination"], ["2", 0])
        self.assertEqual(graph["18"]["inputs"]["trim_amount"], ["16", 3])

    def test_local_graph_keeps_source_audio_and_masks_composite(self):
        graph = module.workflow("source.mp4", "test", "Orange button-down", target="jacket")
        self.assertEqual(graph["20"]["inputs"]["destination"], ["2", 0])
        self.assertEqual(graph["20"]["inputs"]["mask"], ["6", 0])
        self.assertEqual(graph["21"]["inputs"]["audio"], ["2", 1])
        self.assertEqual(graph["16"]["inputs"]["length"], 49)
        self.assertEqual(graph["17"]["inputs"]["denoise"], 1)
        self.assertEqual(graph["18"]["inputs"]["trim_amount"], ["16", 3])
        self.assertEqual(graph["9"]["class_type"], "SaveVideo")
        self.assertFalse(any("Api" in node["class_type"] for node in graph.values()))
        for node in graph.values():
            for value in node["inputs"].values():
                if isinstance(value, list):
                    self.assertIn(value[0], graph)

    def test_target_has_no_silent_default(self):
        with self.assertRaisesRegex(ValueError, "Identify"):
            module.workflow("source.mp4", "test", "Orange linen")
        for target in ["dress", "trousers", "jacket worn by the person on the left"]:
            graph = module.workflow("source.mp4", "test", "Orange linen", target=target)
            self.assertEqual(graph["4"]["inputs"]["text"], target)


if __name__ == "__main__":
    unittest.main()