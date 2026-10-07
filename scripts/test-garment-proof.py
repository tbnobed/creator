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
        for target in ["dress", "trousers", "jacket worn by the person on the left", "person on the right", "wooden chair", "parked car"]:
            graph = module.workflow("source.mp4", "test", "Orange linen", target=target)
            self.assertEqual(graph["4"]["inputs"]["text"], target)

    def test_replacement_reference_is_not_clothing_or_identity_locked(self):
        for target in ["red dress", "person on the left", "wooden chair", "parked car"]:
            graph = module.workflow("source.mp4", "test", "Use the reference appearance", reference="reference.png", target=target)
            positive = graph["14"]["inputs"]["text"]
            negative = graph["15"]["inputs"]["text"]
            self.assertIn(target, positive)
            self.assertIn("all non-target people and objects unchanged", positive)
            self.assertNotIn("Keep the original person", positive)
            self.assertNotIn("selected garment", positive)
            self.assertNotIn("changed face", negative)
            self.assertNotIn("changed hands", negative)
            self.assertEqual(graph["4"]["inputs"]["text"], target)

    def test_reference_fidelity_and_requested_override_reach_model(self):
        graph = module.workflow("source.mp4", "test", "orange background", reference="design.png", target="jacket")
        text = graph["14"]["inputs"]["text"]
        self.assertIn("orange background", text)
        self.assertIn("patterns or markings, including their size and placement", text)
        self.assertIn("Explicit instructions override conflicting reference details", text)
        self.assertIn("missing reference details", graph["15"]["inputs"]["text"])

    def test_artwork_does_not_inherit_replacement_instructions(self):
        for reference in [None, "design.png"]:
            graph = module.artwork_workflow("source.mp4", "test", "Birds flap their wings", reference=reference, target="jacket")
            text = graph["14"]["inputs"]["text"]
            self.assertIn("Birds flap their wings", text)
            self.assertNotIn("Replace the selected garment", text)
            self.assertEqual(graph["21"]["inputs"]["audio"], ["2", 1])


if __name__ == "__main__":
    unittest.main()