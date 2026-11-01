"""Tiny synthetic videos made with ffmpeg (a few KB, ~1 s to build). Nothing real, nothing downloaded."""
from __future__ import annotations
import subprocess
from pathlib import Path

import numpy as np


def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def logo_png(path: Path, size: int = 216) -> Path:
    """A size x size high-contrast checker 'logo' at delivery resolution (PGM; ffmpeg reads it)."""
    b = size // 6
    yy, xx = np.mgrid[0:size, 0:size]
    g = np.where(((xx // b) + (yy // b)) % 2 == 0, 255, 0).astype(np.uint8)
    g[size // 2 - b // 2 : size // 2 + b // 2, :] = 128
    path.write_bytes(f"P5 {size} {size} 255\n".encode() + g.tobytes())
    return path


def make_video(path: Path, w=1080, h=1920, dur=6.0, fps=30, volume_db=-20.0, logo: Path | None = None,
               logo_window=(0.0, 3.0), cut_at: float | None = 3.0, clip=False) -> Path:
    """Vertical colour video with a sine tone. Optional logo overlay in a window, one hard cut, optional clipping."""
    vin = f"color=c=0x035E5E:s={w}x{h}:r={fps}:d={dur}"
    vin2 = f"color=c=0xF4EFE6:s={w}x{h}:r={fps}:d={dur}"
    vol = "volume=12" if clip else f"volume={volume_db}dB"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", vin, "-f", "lavfi", "-i", vin2,
           "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={dur}"]
    filt = []
    if cut_at is not None:
        filt.append(f"[0:v][1:v]overlay=enable='gte(t,{cut_at})'[bg]")
    else:
        filt.append("[0:v]null[bg]")
    if logo is not None:
        cmd += ["-loop", "1", "-i", str(logo)]
        filt.append("[3:v]format=yuv420p[lg]")
        filt.append(f"[bg][lg]overlay=40:40:enable='between(t,{logo_window[0]},{logo_window[1]})':shortest=1[v]")
    else:
        filt.append("[bg]null[v]")
    filt.append(f"[2:a]{vol}[a]")
    cmd += ["-filter_complex", ";".join(filt), "-map", "[v]", "-map", "[a]", "-t", str(dur),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", str(path)]
    _run(cmd)
    return path


CHECKLIST = [
    {"id": "c_len", "text": "Runs 5 to 8 seconds", "kind": "check", "measure": {"metric": "duration_s", "op": "between", "value": 5, "max": 8}},
    {"id": "c_res", "text": "At least 1080p", "kind": "check", "measure": {"metric": "resolution_p", "op": ">=", "value": 1080}},
    {"id": "c_ar", "text": "Vertical 9:16", "kind": "check", "measure": {"metric": "aspect_ratio", "op": "==", "value": "9:16"}},
    {"id": "c_fps", "text": "30 fps", "kind": "check", "measure": {"metric": "fps", "op": "==", "value": 30}},
    {"id": "c_fmt", "text": "H.264 video", "kind": "check", "measure": {"metric": "format", "op": "==", "value": "h264"}},
    {"id": "c_loud", "text": "Loudness between -16 and -12 LUFS", "kind": "check", "measure": {"metric": "loudness_lufs", "op": "between", "value": -16, "max": -12}},
    {"id": "c_clip", "text": "No audio clipping", "kind": "check", "measure": {"metric": "clipping", "op": "absent"}},
    {"id": "c_logo", "text": "Logo visible in the first 3 seconds", "kind": "check", "measure": {"metric": "logo_present", "op": "present", "value": "logo", "window": [0, 3]}},
    {"id": "c_caps", "text": "Captions match the script", "kind": "check", "measure": {"metric": "caption_present", "op": ">=", "value": 0.95}},
    {"id": "c_hook", "text": "Hook spoken by 2 seconds", "kind": "check", "measure": {"metric": "hook_by_s", "op": "<=", "value": 2}},
    {"id": "t_vibe", "text": "Feels warm and punchy", "kind": "taste", "source": "punchy"},
]

SCRIPT = "Little steps start today. Join the workshop this Saturday. Book your seat now."
TRANSCRIPT_OK = [
    {"start": 0.4, "end": 1.8, "text": "Little steps start today."},
    {"start": 2.0, "end": 3.9, "text": "Join the workshop this Saturday."},
    {"start": 4.1, "end": 5.6, "text": "Book your seat now."},
]
TRANSCRIPT_MISSING = TRANSCRIPT_OK[:2] + [{"start": 4.1, "end": 5.6, "text": "Thanks for watching."}]

TERMS = {
    "title": "Workshop promo reel",
    "currency": "USD",
    "client": {"role": "client", "userId": "u_client_1", "displayName": "Asha Rao", "country": "India", "org": "Kalpa Crafts"},
    "worker": {"role": "worker", "userId": "u_worker_1", "displayName": "John Miller", "country": "United States", "paypalEmail": "john@example.com"},
    "milestones": [{"key": "m1", "title": "Reel v1", "amountMinor": 50000, "dueAt": "2026-11-10T00:00:00Z", "graceHours": 24,
                    "reviewWindowHours": 72, "revisionRoundsIncluded": 2, "styleSample": False, "checklist": CHECKLIST,
                    "payees": [{"userId": "u_worker_1", "email": "john@example.com", "shareBp": 10000, "displayName": "John Miller"}]}],
    "rateCard": [{"id": "rc_extra_cut", "label": "Extra cut-down version", "unit": "version", "unitPriceMinor": 8000},
                 {"id": "rc_captions_lang", "label": "Captions in another language", "unit": "language", "unitPriceMinor": 3000}],
    "killFeeBp": 2500,
    "humanApprovalThresholdMinor": 20000,
}
