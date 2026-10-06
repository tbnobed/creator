"""Bounded, source-pixel artwork articulation. No model calls or demo coordinates."""
import argparse
import json
import math
from pathlib import Path
import subprocess

import cv2
import numpy as np
from PIL import Image


def polygon_mask(points, width, height):
    points = np.array([[p["x"] * (width-1), p["y"] * (height-1)] for p in points])
    mask = np.zeros((height, width), np.uint8)
    cv2.fillPoly(mask, [np.round(points).astype(np.int32)], 255)
    return mask


def render(source, output, config, plate=None):
    cv2.setNumThreads(2)
    cap = cv2.VideoCapture(str(source))
    ok, base = cap.read()
    if not ok:
        raise ValueError("Cannot decode the selected video.")
    h, w = base.shape[:2]
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not (0 < fps <= 30 and 1 <= frames <= 151 and w*h <= 1280*720):
        raise ValueError("Use a draft up to five seconds and 720p.")
    region = polygon_mask(config["polygon"], w, h)
    protected = np.zeros_like(region)
    for points in config.get("protectedPolygons", []):
        protected |= polygon_mask(points, w, h)
    if (region > 0).sum() < 20 or (region > 0).sum() > w*h*.20:
        raise ValueError("Select one moving part, between 20 pixels and 20% of the frame.")
    erase = cv2.dilate(region, np.ones((5, 5), np.uint8))
    erase[protected > 0] = 0
    if plate:
        with Image.open(plate) as header:
            if header.width*header.height > 20_000_000:
                raise ValueError("Use a clean fabric image smaller than 20 megapixels.")
        clean = cv2.imread(str(plate))
        if clean is None or abs(clean.shape[1]/clean.shape[0]-w/h) > .02:
            raise ValueError("Clean fabric image must match the selected frame's aspect ratio.")
        clean = cv2.resize(clean, (w, h))
    else:
        clean = cv2.inpaint(base, erase, 5, cv2.INPAINT_TELEA)
    # Generic color difference, not a monkey-, color-, skin- or garment-specific key.
    distance = np.linalg.norm(base.astype(np.float32)-clean.astype(np.float32), axis=2)
    ink = ((distance >= config["inkThreshold"]) & (region > 0) & (protected == 0)).astype(np.uint8)*255
    if (ink > 0).sum() < 12:
        raise ValueError("No distinct ink selected. Adjust the outline/ink threshold or supply a clean fabric image.")
    alpha = cv2.GaussianBlur(ink.astype(np.float32)/255, (3, 3), .6)
    alpha[protected > 0] = 0
    gray0 = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    tracker = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    pivot = (config["pivot"]["x"]*(w-1), config["pivot"]["y"]*(h-1))
    # Fail instead of silently cropping a moving limb at the frame boundary.
    coords = np.column_stack(np.where(region > 0)[::-1]).astype(np.float32)
    for angle in np.linspace(0, config["angleDegrees"], 12):
        moved = cv2.transform(coords[None], cv2.getRotationMatrix2D(pivot, float(angle), 1))[0]
        if (moved < 2).any() or (moved[:, 0] > w-3).any() or (moved[:, 1] > h-3).any():
            raise ValueError("The motion reaches the frame edge. Reduce its angle or change the pivot.")
    silent = Path(output).with_name("silent.mp4")
    writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        raise ValueError("Video encoder unavailable.")
    count, max_changed, poor_frames = 0, 0, 0
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            reverse = tracker.calc(gray, gray0, None)
            forward = tracker.calc(gray0, gray, None)
            mx, my = xx+reverse[:, :, 0], yy+reverse[:, :, 1]
            consistency = reverse + cv2.remap(forward, mx, my, cv2.INTER_LINEAR)
            valid = np.linalg.norm(consistency, axis=2) < 3.5
            valid &= (mx >= 0) & (mx < w-1) & (my >= 0) & (my < h-1)
            fixed = cv2.remap(protected, mx, my, cv2.INTER_NEAREST) > 0
            old = cv2.remap(erase, mx, my, cv2.INTER_NEAREST)
            selected = old > 0
            if selected.sum() < 20 or valid[selected].mean() < .55:
                poor_frames += 1
                if poor_frames >= 4:
                    raise ValueError("Artwork tracking became unreliable. Choose a shorter window with less occlusion.")
            else:
                poor_frames = 0
            original = cv2.remap(base, mx, my, cv2.INTER_LINEAR)
            # Reject major appearance changes (foreground occlusion), not skin color.
            mismatch = np.linalg.norm(frame.astype(np.float32)-original.astype(np.float32), axis=2) > 95
            hidden = fixed | ~valid | (cv2.dilate(mismatch.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
            t = count/fps
            duration = frames/fps
            ramp = min(1, t/.25, max(0, (duration-1/fps-t)/.25))
            angle = config["angleDegrees"]*(.5-.5*math.cos(2*math.pi*config["cyclesPerSecond"]*t))*ramp
            matrix = cv2.getRotationMatrix2D(pivot, angle, 1)
            a = cv2.remap(cv2.warpAffine(alpha, matrix, (w, h)), mx, my, cv2.INTER_LINEAR)
            premul = cv2.warpAffine(base.astype(np.float32)*alpha[:, :, None], matrix, (w, h))
            colors = cv2.remap(premul, mx, my, cv2.INTER_LINEAR)/np.maximum(a[:, :, None], 1e-5)
            light = cv2.GaussianBlur(frame.astype(np.float32), (0, 0), 12)
            ref_light = cv2.GaussianBlur(original.astype(np.float32), (0, 0), 12)
            gain = np.clip(light/np.maximum(ref_light, 30), .8, 1.2)
            colors *= gain
            fill = cv2.remap(clean, mx, my, cv2.INTER_LINEAR).astype(np.float32)*gain
            remove = cv2.GaussianBlur(old.astype(np.float32)/255, (5, 5), 1)
            # Leave exact resting poses untouched, including the first/last frame.
            strength = min(1, abs(angle)/2)
            remove *= strength
            a *= strength
            remove[hidden] = 0
            a[hidden] = 0
            result = frame*(1-remove[:, :, None])+fill*remove[:, :, None]
            result = np.clip(result*(1-a[:, :, None])+colors*a[:, :, None], 0, 255).astype(np.uint8)
            support = (remove > .001) | (a > .001)
            result[~support] = frame[~support]
            assert np.array_equal(result[~support], frame[~support])
            max_changed = max(max_changed, int(support.sum()))
            writer.write(result)
            if count in {0, frames//4, frames//2, frames-1}:
                cv2.imwrite(str(Path(output).with_name(f"check-{count:03}.jpg")), np.concatenate([frame, result], axis=1))
            count += 1
    finally:
        cap.release()
        writer.release()
    if count != frames:
        raise ValueError("Video ended unexpectedly; the incomplete render was not saved.")
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(silent), "-i", str(source),
                    "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-crf", "17",
                    "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(output)], check=True)
    silent.unlink()
    Path(output).with_suffix(".json").write_text(json.dumps({
        "frames": count, "fps": fps, "maxEditedPixels": max_changed,
        "outsideMaskUnchangedBeforeEncoding": True, "usesCleanPlate": bool(plate),
        "renderer": "source-pixel-v1",
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--plate")
    args = parser.parse_args()
    render(args.source, args.output, json.loads(Path(args.config).read_text()), args.plate)
