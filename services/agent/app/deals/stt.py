"""Speech-to-text for the captions-vs-script and hook checks: faster-whisper, CPU, int8.

Optional dependency (requirements-stt.txt). The model is loaded once per process and
cached on disk (WHISPER_CACHE, default ~/.cache/yv-whisper). Tests never load it: they
pass a transcript, or a stub `stt` callable, to the Video QA agent. One gated test
(RUN_WHISPER=1) runs the real model.
"""
from __future__ import annotations
import os
from functools import lru_cache


class SttUnavailable(RuntimeError):
    pass


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


@lru_cache(maxsize=2)
def _model(size: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover - depends on the optional install
        raise SttUnavailable("faster-whisper is not installed (pip install -r requirements-stt.txt)") from e
    root = os.environ.get("WHISPER_CACHE", os.path.expanduser("~/.cache/yv-whisper"))
    return WhisperModel(size, device="cpu", compute_type=compute_type, download_root=root,
                        cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")))


def transcribe(path: str, size: str | None = None, compute_type: str = "int8", language: str | None = None) -> list[dict]:
    """Timestamped segments [{start, end, text}] for a media file."""
    model = _model(size or os.environ.get("WHISPER_MODEL", "small"), compute_type)
    segments, _info = model.transcribe(path, language=language, vad_filter=True, beam_size=1)
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]


# metrics whose check needs what was said
NEEDS_TRANSCRIPT = {"caption_present", "hook_by_s"}
