import importlib.util
import pathlib
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("print_proof", pathlib.Path(__file__).with_name("garment-print-proof.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrintProofTests(unittest.TestCase):
    def test_ink_inherits_broad_fabric_shadow(self):
        frame = np.full((80, 80, 3), 60, np.uint8)
        frame[:,:40] = 10
        result = module.composite(frame, np.full((80,80,4),255,np.uint8),np.full((80,80),255,np.uint8))
        self.assertLess(float(result[20:60,10:25].mean()),float(result[20:60,55:70].mean()) * .5)

    def test_stationary_material_coordinates_do_not_drift(self):
        rng = np.random.default_rng(2)
        gray = rng.integers(0,255,(80,80),dtype=np.uint8)
        y,x = np.mgrid[:80,:80].astype(np.float32)
        uv = np.stack([x,y],axis=2)
        tracked = module.surface_coordinates(gray,gray,uv,np.array([[1.,0.,0.],[0.,1.,0.]]))
        self.assertLess(float(np.abs(tracked[10:-10,10:-10]-uv[10:-10,10:-10]).mean()),.05)

    def test_artwork_moves_without_shirt_movement(self):
        first, later = module.artwork(0), module.artwork(.35)
        self.assertGreater(np.count_nonzero(first != later), 10000)
        self.assertTrue(np.array_equal(first, module.artwork(0)))

    def test_mask_protects_source_and_foreground_holes(self):
        frame = np.full((80, 80, 3), 40, np.uint8)
        ink = np.full((80, 80, 4), 255, np.uint8)
        mask = np.zeros((80, 80), np.uint8)
        mask[10:70, 10:70] = 255
        mask[30:50, 30:50] = 0
        result = module.composite(frame, ink, mask)
        self.assertTrue(np.array_equal(result[mask == 0], frame[mask == 0]))
        self.assertGreater(int(result[20, 20, 0]), 40)

    def test_empty_mask_makes_no_edit(self):
        frame = np.full((80, 80, 3), 63, np.uint8)
        result = module.composite(frame, np.full((80,80,4),255,np.uint8), np.zeros((80,80),np.uint8))
        self.assertTrue(np.array_equal(frame, result))


if __name__ == "__main__":
    unittest.main()