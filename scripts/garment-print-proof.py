#!/usr/bin/env python3
"""CPU-only moving-print proof. SAM mask + dense local surface tracking.

This is a short-shot prototype, not dense cloth simulation or a production job API.
Requires numpy, pillow, opencv-python-headless and ffmpeg.
"""
import argparse
import json
import math
import pathlib
import subprocess
import tempfile

import cv2
import numpy as np
from PIL import Image, ImageDraw


def artwork(t, size=320):
    """Two original cartoon monkeys hopping, waving and playing with a ball."""
    im = Image.new("RGBA", (320, 240))
    d = ImageDraw.Draw(im)
    brown, dark, tan = "#97582f", "#472a24", "#f5c98e"
    for index, x in enumerate([86, 233]):
        phase = t * math.tau * .85 + index * math.pi
        hop = max(0, math.sin(phase)) * 24
        y = 128 - hop
        # Curling tail changes shape independently of the shirt and body.
        points = [(x + (j * 2.2 - 35) * (-1 if index else 1),
                   y + 18 + 16 * math.sin(j / 7 + phase)) for j in range(22)]
        d.line(points, fill=dark, width=9)
        d.line(points, fill=brown, width=6)
        for side in [-1, 1]:
            knee = (x + side * 22, y + 37)
            foot = (x + side * (29 + 5 * math.cos(phase)), y + 56)
            d.line([(x + side * 11, y + 16), knee, foot], fill=dark, width=13)
            d.line([(x + side * 11, y + 16), knee, foot], fill=brown, width=9)
            d.ellipse((foot[0]-10, foot[1]-4, foot[0]+8, foot[1]+5), fill=tan)
            elbow = (x + side * 31, y - 7 - 15 * math.sin(phase + side))
            hand = (x + side * 44, y - 22 - 23 * math.sin(phase + side))
            d.line([(x + side * 13, y - 9), elbow, hand], fill=dark, width=12)
            d.line([(x + side * 13, y - 9), elbow, hand], fill=brown, width=8)
            d.ellipse((hand[0]-6, hand[1]-6, hand[0]+6, hand[1]+6), fill=tan)
        d.ellipse((x-23, y-29, x+23, y+32), fill=brown, outline=dark, width=3)
        d.ellipse((x-15, y-19, x+15, y+23), fill=tan)
        for side in [-1, 1]:
            ex = x + side * 27
            d.ellipse((ex-10, y-64, ex+10, y-44), fill=brown, outline=dark, width=2)
            d.ellipse((ex-6, y-60, ex+6, y-48), fill=tan)
        d.ellipse((x-29, y-83, x+29, y-29), fill=brown, outline=dark, width=3)
        d.ellipse((x-22, y-75, x+22, y-34), fill=tan)
        for side in [-1, 1]:
            ex = x + side * 9
            d.ellipse((ex-3, y-65, ex+3, y-57), fill=dark)
        d.ellipse((x-4, y-52, x+4, y-47), fill=dark)
        d.arc((x-11, y-56, x+11, y-38), 5, 175, fill=dark, width=2)
    bx = 160 + 24 * math.sin(t * math.tau * .85)
    by = 149 - 80 * abs(math.sin(t * math.tau * .85))
    d.ellipse((bx-12, by-12, bx+12, by+12), fill="#eeae35", outline=dark, width=3)
    d.arc((bx-7, by-12, bx+7, by+12), 60, 270, fill="#c94f45", width=3)
    return np.asarray(im.resize((size, round(size * .75)), Image.Resampling.LANCZOS))


def composite(frame, rgba, mask):
    alpha = rgba[:, :, 3:4].astype(np.float32) / 255
    # Hard outside-mask protection; slight inward feather hides segmentation noise.
    clip = cv2.erode(mask, np.ones((3, 3), np.uint8)).astype(np.float32) / 255
    alpha *= clip[:, :, None]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Ink inherits broad shadows AND fine fabric contrast, rather than replacing
    # both with a uniformly lit illustration. No generated grain or drop shadow.
    cloth = gray[mask > 0]
    white = max(22., float(np.percentile(cloth, 90))) if cloth.size else 22.
    low = cv2.GaussianBlur(gray, (0, 0), 1.2)
    shading = np.clip((low / white) ** .85, .08, 1.05)[:, :, None]
    texture = np.clip((gray + 8) / (low + 8), .65, 1.25)[:, :, None]
    ink = rgba[:, :, :3][:, :, ::-1].astype(np.float32) * shading * texture * .78
    # Matte printed ink, retaining some underlying material even in solid colors.
    alpha *= .86
    return np.clip(frame * (1-alpha) + ink * alpha, 0, 255).astype(np.uint8)


def surface_coordinates(previous, current, uv, delta):
    """Advect material coordinates, not rendered characters, through dense flow."""
    h, w = current.shape
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    back = cv2.calcOpticalFlowFarneback(current, previous, None, .5, 3, 19, 4, 7, 1.5, 0)
    forward = cv2.calcOpticalFlowFarneback(previous, current, None, .5, 3, 19, 4, 7, 1.5, 0)
    mx, my = xx + back[:,:,0], yy + back[:,:,1]
    check = cv2.remap(forward, mx, my, cv2.INTER_LINEAR)
    reliable = np.linalg.norm(back + check, axis=2) < 1.0
    # Unobservable pixels use the already-validated coarse shirt transform.
    inv = cv2.invertAffineTransform(delta)
    ax = inv[0,0]*xx + inv[0,1]*yy + inv[0,2]
    ay = inv[1,0]*xx + inv[1,1]*yy + inv[1,2]
    reliable &= np.hypot(mx-ax, my-ay) < 5
    return cv2.remap(uv, np.where(reliable,mx,ax).astype(np.float32),
                     np.where(reliable,my,ay).astype(np.float32), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REPLICATE)


def render(source, mask_path, output):
    video, masks = cv2.VideoCapture(str(source)), cv2.VideoCapture(str(mask_path))
    fps = video.get(cv2.CAP_PROP_FPS)
    w, h = int(video.get(3)), int(video.get(4))
    count = int(video.get(cv2.CAP_PROP_FRAME_COUNT))
    if not fps or not count or count > 160 or max(w, h) > 1920:
        raise ValueError("Proof requires a measurable short clip of at most 160 frames and 1920px.")
    if (int(masks.get(3)), int(masks.get(4)), int(masks.get(7))) != (w, h, count):
        raise ValueError("Tracking mask must have the same dimensions and frame count.")
    if abs(masks.get(cv2.CAP_PROP_FPS) - fps) > .01:
        raise ValueError("Tracking-mask frame rate differs from source.")
    errors, frames = [], 0
    previous, points = None, None
    with tempfile.TemporaryDirectory(prefix="garment-print-") as directory:
        silent = str(pathlib.Path(directory) / "silent.mp4")
        writer = cv2.VideoWriter(silent, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        if not writer.isOpened():
            raise RuntimeError("Video encoder unavailable.")
        try:
            for i in range(count):
                ok, frame = video.read()
                mok, mask_frame = masks.read()
                if not ok or not mok:
                    raise ValueError("Source/mask decode ended before the advertised frame count.")
                mask = (cv2.cvtColor(mask_frame, cv2.COLOR_BGR2GRAY) > 127).astype(np.uint8) * 255
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                if i == 0:
                    ys, xs = np.where(mask > 0)
                    if len(xs) < w*h*.02:
                        raise ValueError("No usable shirt mask.")
                    top, bottom = int(ys.min()), int(ys.max())
                    band = mask[top+int((bottom-top)*.30):top+int((bottom-top)*.50)]
                    _, chest_x = np.where(band > 0)
                    if len(chest_x) < 20:
                        raise ValueError("Shirt chest region could not be located.")
                    center = float(np.median(chest_x))
                    width = float(np.percentile(chest_x, 95)-np.percentile(chest_x, 5)) * .68
                    # Entire illustration stays below collar and above waist.
                    base = np.array([[width/320, 0, center-width/2],
                                     [0, width/320, top+(bottom-top)*.28],
                                     [0, 0, 1]], dtype=np.float64)
                    yy, xx = np.mgrid[:h, :w].astype(np.float32)
                    # Monocular fold relief is approximate: image contrast provides
                    # initial local bending, then measured flow carries it in time.
                    relief = cv2.GaussianBlur(gray.astype(np.float32), (0,0), 1.5)
                    relief -= cv2.GaussianBlur(relief, (0,0), 8)
                    dx = np.clip(cv2.Sobel(relief,cv2.CV_32F,1,0)*.10,-2.5,2.5)
                    dy = np.clip(cv2.Sobel(relief,cv2.CV_32F,0,1)*.10,-2.5,2.5)
                    inv = np.linalg.inv(base)
                    uv = np.stack([(xx+dx-base[0,2])*inv[0,0],
                                   (yy+dy-base[1,2])*inv[1,1]], axis=2).astype(np.float32)
                else:
                    if points is None or len(points) < 8:
                        raise RuntimeError(f"Insufficient garment features at frame {i}; refusing untracked output.")
                    nxt, valid, _ = cv2.calcOpticalFlowPyrLK(previous, gray, points, None, winSize=(21, 21), maxLevel=3)
                    if nxt is None:
                        raise RuntimeError(f"Optical flow failed at frame {i}.")
                    back, back_valid, _ = cv2.calcOpticalFlowPyrLK(gray, previous, nxt, None, winSize=(21,21), maxLevel=3)
                    if back is None:
                        raise RuntimeError(f"Reverse flow failed at frame {i}.")
                    good = (valid.ravel()>0) & (back_valid.ravel()>0) & (np.linalg.norm(points-back,axis=2).ravel()<1.5)
                    xy = np.rint(nxt[:,0]).astype(int)
                    inside = (xy[:,0]>=0)&(xy[:,0]<w)&(xy[:,1]>=0)&(xy[:,1]<h)
                    good &= inside
                    good[inside] &= mask[xy[inside,1],xy[inside,0]] > 0
                    if good.sum() < 8:
                        raise RuntimeError(f"Tracking confidence too low at frame {i}.")
                    delta, inliers = cv2.estimateAffinePartial2D(points[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=1.5)
                    if delta is None or inliers.sum() < 6 or not .95 < np.linalg.det(delta[:,:2]) < 1.05 or np.linalg.norm(delta[:,2]) > 8:
                        raise RuntimeError(f"Unreliable shirt motion at frame {i}; no output accepted.")
                    errors.append(int(inliers.sum()))
                    uv = surface_coordinates(previous, gray, uv, delta)
                print_rgba = cv2.remap(artwork(i/fps), uv[:,:,0], uv[:,:,1], cv2.INTER_LINEAR)
                composed = composite(frame, print_rgba, mask)
                if not np.array_equal(composed[mask == 0], frame[mask == 0]):
                    raise AssertionError("Outside-mask source pixels changed before encoding.")
                writer.write(composed)
                previous = gray
                # Reacquire only shirt features; never track the animated ink itself.
                feature_mask = cv2.erode(mask, np.ones((7,7),np.uint8))
                points = cv2.goodFeaturesToTrack(gray, 160, .003, 4, mask=feature_mask)
                frames += 1
        finally:
            writer.release()
            video.release()
            masks.release()
        subprocess.run(["ffmpeg", "-v", "error", "-i", silent, "-i", str(source),
                        "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-crf", "17",
                        "-c:a", "copy", "-movflags", "+faststart", "-y", str(output)], check=True)
    return {"frames": frames, "fps": fps, "minTrackingInliers": min(errors) if errors else None,
            "outsideMaskPixels": "unchanged before encoding",
            "tracking": "dense 2D material-coordinate flow with affine fallback; approximate monocular fold relief"}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=pathlib.Path, required=True)
    p.add_argument("--mask", type=pathlib.Path, required=True)
    p.add_argument("--output", type=pathlib.Path, required=True)
    args = p.parse_args()
    print(json.dumps(render(args.source, args.mask, args.output), indent=2))