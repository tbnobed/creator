"""Prepare complete garment/artwork references for VACE's center-crop input."""
import argparse
from PIL import Image, ImageOps


def prepare(source, destination):
    with Image.open(source) as original:
        if original.width * original.height > 24_000_000:
            raise ValueError("Reference image exceeds 24 megapixels.")
        image = ImageOps.exif_transpose(original).convert("RGBA")
        # Flatten transparency before resizing; keep every edge of the design.
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(image)
        fitted = ImageOps.contain(background.convert("RGB"), (512, 288), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (512, 288), "white")
        canvas.paste(fitted, ((512 - fitted.width) // 2, (288 - fitted.height) // 2))
        canvas.save(destination, format="PNG")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    prepare(args.input, args.output)