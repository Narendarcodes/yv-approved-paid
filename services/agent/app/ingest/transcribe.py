"""Transcription worker step: Whisper via an HTTP STT endpoint (STT_URL; e.g. a GPU-resident
whisper-large-v3-turbo sidecar), chunked into fixed windows so we get timestamped segments.
Falls back to fixture transcripts when no STT_URL is configured."""
from __future__ import annotations
import base64
import io
import json
import os
import shutil
import subprocess
import tempfile
import wave

import httpx

from ..config import get_settings


def to_wav16k(path: str) -> str:
    if path.lower().endswith(".wav"):
        with wave.open(path) as w:
            if w.getframerate() == 16000 and w.getnchannels() == 1:
                return path
    if not shutil.which("ffmpeg"):
        if path.lower().endswith(".wav"):
            return path  # STT server resamples itself
        raise RuntimeError("ffmpeg is required to decode non-wav media")
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", out], check=True)
    return out


def chunk_wav(path: str, chunk_s: float) -> list[tuple[float, float, bytes]]:
    out = []
    with wave.open(path) as w:
        rate, n = w.getframerate(), w.getnframes()
        per = int(rate * chunk_s)
        pos = 0
        while pos < n:
            frames = w.readframes(per)
            k = len(frames) // (w.getsampwidth() * w.getnchannels())
            buf = io.BytesIO()
            with wave.open(buf, "wb") as o:
                o.setnchannels(w.getnchannels()); o.setsampwidth(w.getsampwidth()); o.setframerate(rate)
                o.writeframes(frames)
            out.append((round(pos / rate, 2), round((pos + k) / rate, 2), buf.getvalue()))
            pos += k
            if k == 0:
                break
    return out


async def transcribe(path: str, language: str = "en", transport: httpx.AsyncBaseTransport | None = None) -> tuple[list[dict], str]:
    s = get_settings()
    if not s.stt_url:
        fx = os.path.join(s.fixtures_dir, "transcripts", os.path.splitext(os.path.basename(path))[0] + ".json")
        if os.path.exists(fx):
            return json.load(open(fx)), "fixture"
        raise RuntimeError("no STT_URL configured and no fixture transcript for " + os.path.basename(path))
    wav = to_wav16k(path)
    segs, model = [], s.stt_engine
    async with httpx.AsyncClient(timeout=120, transport=transport) as http:
        for start, end, data in chunk_wav(wav, s.stt_chunk_s):
            body = {"language": "en" if language == "auto" else language, "engine": s.stt_engine, "audio_b64": base64.b64encode(data).decode(), "normalize": "none"}
            r = await http.post(s.stt_url, json=body)
            r.raise_for_status()
            doc = r.json()
            model = doc.get("model") or model
            text = (doc.get("text") or doc.get("raw") or "").strip()
            if text:
                segs.append({"start": start, "end": end, "text": text})
    return segs, f"{s.stt_engine} ({model}) via STT_URL"
