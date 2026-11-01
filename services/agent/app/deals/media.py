"""Machine checks for a delivered video, each with timestamped evidence.

The ffprobe / ffmpeg helpers (`probe`, `_ffmpeg`, `extract_frames`) are reused from
NaruClip-Engine (github.com/Narendarcodes/NaruClip-Engine, src/naru/media/ffmpeg.py, MIT),
extended here with loudness (EBU R128 via ffmpeg `ebur128`), clipping, raw grey-frame
sampling and a numpy template matcher. No torch / pyannote / ultralytics: ffmpeg + numpy only
(OpenCV's matchTemplate is used when it happens to be installed, same maths).

Every check returns a CheckResult: measured value, the checklist measure it was held to,
pass/fail, and evidence (time span + a screenshot path). The checks never decide pay:
they report facts; the policy engine and the people on the deal decide what follows.
"""
from __future__ import annotations
import json
import re
import subprocess
from dataclasses import dataclass, field, asdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

import numpy as np


# ---------------------------------------------------------------- NaruClip helpers (reused)
@dataclass
class MediaInfo:
    width: int
    height: int
    fps: float
    duration_sec: float
    codec: str
    has_audio: bool
    audio_codec: Optional[str] = None
    container: str = ""


def probe(path: str) -> MediaInfo:
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe failed on {path}: {e.stderr}") from e
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise ValueError(f"No video stream found in {path}")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    num, den = video.get("r_frame_rate", "30/1").split("/")
    fps = float(num) / float(den) if float(den) != 0 else 30.0
    return MediaInfo(
        width=int(video["width"]), height=int(video["height"]), fps=fps,
        duration_sec=float(data["format"]["duration"]), codec=video.get("codec_name", "unknown"),
        has_audio=audio is not None, audio_codec=audio.get("codec_name") if audio else None,
        container=data["format"].get("format_name", ""),
    )


def _ffmpeg(cmd: list[str], desc: str = "ffmpeg") -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"{desc} failed:\n  cmd: {' '.join(cmd)}\n  stderr: {e.stderr[:5000]}") from e


def extract_frames(source: str, output_dir: str, fps: float = 1.0, max_frames: int = 0, scale: Optional[str] = None) -> list[str]:
    out_pattern = str(Path(output_dir) / "frame_%05d.jpg")
    vf = f"fps={fps}" + (f",scale={scale}" if scale else "")
    cmd = ["ffmpeg", "-y", "-i", source, "-vf", vf]
    if max_frames:
        cmd += ["-vframes", str(max_frames)]
    cmd += ["-q:v", "2", out_pattern]
    _ffmpeg(cmd, desc="frame extraction")
    return [str(f) for f in sorted(Path(output_dir).glob("frame_*.jpg"))]


# ---------------------------------------------------------------- new helpers
def screenshot(source: str, t: float, out: str, width: int = 480) -> str:
    _ffmpeg(["ffmpeg", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", source, "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", out], "screenshot")
    return out


def loudness(source: str) -> dict:
    """EBU R128 integrated loudness (LUFS), loudness range and true peak (dBTP), plus clipped-sample spans."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", source, "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    err = r.stderr
    summ = err[err.rfind("Summary:"):] if "Summary:" in err else err

    def num(label):
        m = re.search(label + r":\s*(-?[\d.]+|-inf)", summ)
        return None if not m or m.group(1) == "-inf" else float(m.group(1))

    # per-100ms momentary lines -> loudest moment (for evidence)
    peak_t, peak_m = 0.0, -1e9
    for m in re.finditer(r"t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+)", err):
        t, mv = float(m.group(1)), float(m.group(2))
        if mv > peak_m:
            peak_t, peak_m = t, mv
    return {"integrated_lufs": num(r"I"), "lra": num(r"LRA"), "true_peak_dbtp": num(r"Peak"), "loudest_at_s": round(peak_t, 2)}


def clipping_spans(source: str, threshold: float = 0.999, win_s: float = 0.1) -> list[tuple[float, float]]:
    """Time spans (s) where samples hit full scale. Reads mono 8 kHz float PCM."""
    r = subprocess.run(["ffmpeg", "-v", "quiet", "-i", source, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], capture_output=True)
    pcm = np.frombuffer(r.stdout, dtype="<f4")
    if pcm.size == 0:
        return []
    n = int(8000 * win_s)
    hits = np.abs(pcm) >= threshold
    spans: list[tuple[float, float]] = []
    for i in range(0, pcm.size, n):
        if hits[i : i + n].sum() >= 3:  # 3+ full-scale samples in 100 ms = audible clipping
            s, e = i / 8000, min(pcm.size, i + n) / 8000
            if spans and abs(spans[-1][1] - s) < 1e-6:
                spans[-1] = (spans[-1][0], e)
            else:
                spans.append((s, e))
    return spans


def grey_frames(source: str, fps: float = 2.0, width: int = 192) -> tuple[list[np.ndarray], list[float]]:
    info = probe(source)
    h = int(round(info.height * width / info.width / 2) * 2)
    r = subprocess.run(["ffmpeg", "-v", "quiet", "-i", source, "-vf", f"fps={fps},scale={width}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                       capture_output=True)
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    n = buf.size // (width * h)
    frames = [buf[i * width * h : (i + 1) * width * h].reshape(h, width).astype(np.float32) for i in range(n)]
    return frames, [round(i / fps, 3) for i in range(n)]


def load_grey(path: str, scale: float) -> np.ndarray:
    """Load any image ffmpeg can read as greyscale, resized by `scale` (to match the sampled frame size)."""
    info = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path], capture_output=True, text=True)
    s = json.loads(info.stdout)["streams"][0]
    w, h = max(4, int(s["width"] * scale)), max(4, int(s["height"] * scale))
    r = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.uint8).reshape(h, w).astype(np.float32)


def match_score(frame: np.ndarray, tpl: np.ndarray) -> float:
    """Best normalised cross-correlation of tpl anywhere in frame (1.0 = identical)."""
    try:
        import cv2  # same maths, faster, if installed

        return float(cv2.minMaxLoc(cv2.matchTemplate(frame, tpl, cv2.TM_CCOEFF_NORMED))[1])
    except ImportError:
        pass
    th, tw = tpl.shape
    if th > frame.shape[0] or tw > frame.shape[1]:
        return 0.0
    win = np.lib.stride_tricks.sliding_window_view(frame, (th, tw))
    t = tpl - tpl.mean()
    tn = np.sqrt((t * t).sum()) or 1.0
    wm = win.mean(axis=(2, 3), keepdims=True)
    wc = win - wm
    num = (wc * t).sum(axis=(2, 3))
    den = np.sqrt((wc * wc).sum(axis=(2, 3))) * tn
    return float(np.nanmax(np.where(den > 1e-6, num / np.maximum(den, 1e-6), 0.0)))


def words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


# ---------------------------------------------------------------- checks against the signed checklist
@dataclass
class Evidence:
    t_start: float
    t_end: float
    note: str
    screenshot: Optional[str] = None


@dataclass
class CheckResult:
    checklist_id: str
    metric: str
    measured: object
    expected: dict
    passed: bool
    evidence: list[Evidence] = field(default_factory=list)
    status: str = "ok"  # ok | not_measurable

    def to_dict(self) -> dict:
        return asdict(self)


def _cmp(measured, m: dict) -> bool:
    op, v = m.get("op"), m.get("value")
    if measured is None:
        return False
    if op == "present":
        return bool(measured)
    if op == "absent":
        return not measured
    if op == "between":
        return float(v) <= float(measured) <= float(m.get("max"))
    if op == "==":
        if isinstance(v, (int, float)) and isinstance(measured, (int, float)):
            return abs(float(measured) - float(v)) <= max(0.01, abs(float(v)) * 0.005)
        return str(measured).lower() == str(v).lower()
    if op == "<=":
        return float(measured) <= float(v)
    if op == ">=":
        return float(measured) >= float(v)
    return False


def _aspect(w: int, h: int) -> str:
    from math import gcd

    known = {"9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1.0, "4:5": 0.8, "4:3": 4 / 3}
    r = w / h
    for k, val in known.items():
        if abs(r - val) < 0.01:
            return k
    g = gcd(w, h)
    return f"{w // g}:{h // g}"


class VideoChecker:
    """Runs a milestone checklist (items of kind 'check' with a measure) against one file."""

    def __init__(self, path: str, evidence_dir: str, transcript: list[dict] | None = None,
                 script: str | None = None, assets: dict[str, str] | None = None, sample_fps: float = 2.0):
        self.path = path
        self.dir = Path(evidence_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.info = probe(path)
        self.transcript = transcript or []
        self.script = script
        self.assets = assets or {}  # e.g. {"logo": "/path/logo.png"}
        self.sample_fps = sample_fps
        self._loud = None
        self._frames = None

    def _shot(self, cid: str, t: float) -> str:
        return screenshot(self.path, min(t, max(0.0, self.info.duration_sec - 0.05)), str(self.dir / f"{cid}_{t:06.2f}.jpg"))

    def _whole(self, cid: str, note: str) -> list[Evidence]:
        return [Evidence(0.0, round(self.info.duration_sec, 2), note, self._shot(cid, 0.0))]

    def run(self, checklist: list[dict]) -> list[CheckResult]:
        out = []
        for item in checklist:
            if item.get("kind") != "check" or not item.get("measure"):
                continue  # taste lines are for people, never machine-judged
            out.append(self.check(item))
        return out

    def check(self, item: dict) -> CheckResult:
        m = item["measure"]
        metric, cid = m["metric"], item["id"]
        fn = getattr(self, f"m_{metric}", None)
        if fn is None:
            return CheckResult(cid, metric, None, m, False, [], status="not_measurable")
        measured, ev = fn(cid, m)
        return CheckResult(cid, metric, measured, m, _cmp(measured, m), ev)

    # --- metrics (names match Measure.metric in apps/api deals types) ---
    def m_duration_s(self, cid, m):
        d = round(self.info.duration_sec, 2)
        return d, [Evidence(0.0, d, f"file runs {d}s", self._shot(cid, max(0.0, d - 0.1)))]

    def m_resolution_p(self, cid, m):
        p = min(self.info.width, self.info.height)
        return p, self._whole(cid, f"{self.info.width}x{self.info.height}")

    def m_aspect_ratio(self, cid, m):
        a = _aspect(self.info.width, self.info.height)
        return a, self._whole(cid, f"{self.info.width}x{self.info.height} = {a}")

    def m_fps(self, cid, m):
        f = round(self.info.fps, 3)
        return f, self._whole(cid, f"{f} fps")

    def m_format(self, cid, m):
        fmt = f"{self.info.codec}/{self.info.audio_codec or 'none'}"
        want = str(m.get("value", "")).lower()
        meas = self.info.codec if "/" not in want else fmt
        return meas, self._whole(cid, f"video {self.info.codec}, audio {self.info.audio_codec}, container {self.info.container}")

    def _l(self):
        if self._loud is None:
            self._loud = loudness(self.path)
        return self._loud

    def m_loudness_lufs(self, cid, m):
        L = self._l()
        t = L["loudest_at_s"]
        return L["integrated_lufs"], [Evidence(0.0, round(self.info.duration_sec, 2),
                                               f"integrated {L['integrated_lufs']} LUFS, LRA {L['lra']}, loudest moment at {t}s", self._shot(cid, t))]

    def m_true_peak_dbtp(self, cid, m):
        L = self._l()
        return L["true_peak_dbtp"], [Evidence(L["loudest_at_s"], L["loudest_at_s"], f"true peak {L['true_peak_dbtp']} dBTP", self._shot(cid, L["loudest_at_s"]))]

    def m_clipping(self, cid, m):
        spans = clipping_spans(self.path)
        ev = [Evidence(round(s, 2), round(e, 2), "audio hits full scale", self._shot(cid, s)) for s, e in spans[:5]]
        return bool(spans), ev or [Evidence(0.0, round(self.info.duration_sec, 2), "no clipped samples")]

    def _fr(self):
        if self._frames is None:
            self._frames = grey_frames(self.path, self.sample_fps)
        return self._frames

    def m_logo_present(self, cid, m):
        tpl_path = self.assets.get(str(m.get("value") or "logo"))
        if not tpl_path:
            return None, [Evidence(0, 0, "no logo template on the deal")]
        frames, times = self._fr()
        scale = frames[0].shape[1] / self.info.width
        tpl = load_grey(tpl_path, scale)
        lo, hi = m.get("window") or [0.0, self.info.duration_sec]
        thr = float(m.get("threshold", 0.8))
        seen = [(t, s) for f, t in zip(frames, times) if lo <= t <= hi for s in [match_score(f, tpl)] if s >= thr]
        if not seen:
            best = max((match_score(f, tpl), t) for f, t in zip(frames, times) if lo <= t <= hi)
            return False, [Evidence(lo, hi, f"logo not found in window (best match {best[0]:.2f} at {best[1]}s)", self._shot(cid, best[1]))]
        t0, t1 = seen[0][0], seen[-1][0]
        return True, [Evidence(t0, t1, f"logo matched (score {max(s for _, s in seen):.2f}) from {t0}s to {t1}s", self._shot(cid, t0))]

    def m_caption_present(self, cid, m):
        """Captions vs script: every script line must be heard (transcript) in order. Measured = coverage 0..1."""
        if not self.script or not self.transcript:
            return None, [Evidence(0, 0, "needs the signed script and a transcript")]
        lines = [l.strip() for l in re.split(r"[\n.!?]+", self.script) if len(words(l)) >= 2]
        segs = [(float(s["start"]), float(s["end"]), " ".join(words(s["text"]))) for s in self.transcript]
        ev, ok = [], 0
        for line in lines:
            lw = " ".join(words(line))
            best = max(segs, key=lambda sg: SequenceMatcher(None, lw, sg[2]).ratio())
            r = SequenceMatcher(None, lw, best[2]).ratio()
            if r >= 0.75:
                ok += 1
            else:
                ev.append(Evidence(best[0], best[1], f"script line '{line[:60]}' not matched (closest: '{best[2][:60]}', {r:.2f})", self._shot(cid, best[0])))
        cov = round(ok / max(1, len(lines)), 3)
        if not ev:
            ev = [Evidence(segs[0][0], segs[-1][1], f"all {len(lines)} script lines heard in the transcript")]
        return cov if m.get("op") != "present" else cov >= float(m.get("value") or 0.95), ev

    def m_hook_by_s(self, cid, m):
        """First spoken words by N seconds (time of the first transcript segment)."""
        if not self.transcript:
            return None, [Evidence(0, 0, "needs a transcript")]
        t = float(self.transcript[0]["start"])
        return round(t, 2), [Evidence(t, float(self.transcript[0]["end"]), f"first words at {t}s: '{self.transcript[0]['text'][:60]}'", self._shot(cid, t))]

    def m_cut_interval_s(self, cid, m):
        """Longest shot without a cut (frame-difference cut detection on the sampled frames)."""
        frames, times = self._fr()
        cuts = [0.0]
        for i in range(1, len(frames)):
            if float(np.abs(frames[i] - frames[i - 1]).mean()) > 30.0:
                cuts.append(times[i])
        cuts.append(round(self.info.duration_sec, 2))
        gaps = [(cuts[i + 1] - cuts[i], cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]
        g, a, b = max(gaps)
        return round(g, 2), [Evidence(a, b, f"longest shot {g:.2f}s ({len(cuts) - 2} cuts)", self._shot(cid, a))]
