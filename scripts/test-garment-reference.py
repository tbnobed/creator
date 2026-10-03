import importlib.util
import pathlib
import tempfile
import unittest
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("reference", pathlib.Path(__file__).with_name("garment-reference.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReferenceTests(unittest.TestCase):
    def test_api_image_packages_every_required_garment_script(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        import re
        runtime = (root / "artifacts/api-server/src/lib/garment-media.ts").read_text()
        dockerfile = (root / "deployment/Dockerfile.api").read_text()
        scripts = set(re.findall(r'garmentScript\("([^"]+)"\)', runtime))
        self.assertIn("garment-reference.py", scripts)
        for script in scripts:
            self.assertTrue((root / "scripts" / script).is_file())
            self.assertIn(f"/app/scripts/{script} ./scripts/{script}", dockerfile)

    def test_portrait_and_landscape_keep_all_four_edges(self):
        for size in [(200, 400), (800, 200)]:
            with self.subTest(size=size), tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory) / "input.png"
                output = pathlib.Path(directory) / "output.png"
                image = Image.new("RGB", size, "blue")
                draw = ImageDraw.Draw(image)
                draw.rectangle((0, 0, size[0]-1, 20), fill="red")
                draw.rectangle((0, size[1]-21, size[0]-1, size[1]-1), fill="green")
                draw.rectangle((0, 21, 20, size[1]-22), fill="yellow")
                draw.rectangle((size[0]-21, 21, size[0]-1, size[1]-22), fill="magenta")
                image.save(source)
                module.prepare(source, output)
                with Image.open(output) as prepared:
                    self.assertEqual(prepared.size, (512, 288))
                    colors = set(prepared.getdata())
                    for color in [(255,0,0), (0,128,0), (255,255,0), (255,0,255)]:
                        self.assertIn(color, colors)

    def test_transparency_flattens_white_and_invalid_input_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "input.png"
            output = pathlib.Path(directory) / "output.png"
            Image.new("RGBA", (512, 288), (0,0,0,0)).save(source)
            module.prepare(source, output)
            with Image.open(output) as image:
                self.assertEqual(image.getpixel((256,144)), (255,255,255))
            source.write_bytes(b"not an image")
            with self.assertRaises(OSError):
                module.prepare(source, output)


if __name__ == "__main__":
    unittest.main()