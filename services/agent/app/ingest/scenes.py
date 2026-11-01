"""Scene-cut detection with PySceneDetect (ContentDetector). Optional dependency."""
from __future__ import annotations


def detect_cuts(video_path: str, threshold: float = 27.0) -> list[dict]:
    try:
        from scenedetect import ContentDetector, detect
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("PySceneDetect not installed (requirements-media.txt)") from e
    scenes = detect(video_path, ContentDetector(threshold=threshold))
    return [{"second": round(start.get_seconds(), 2)} for start, _end in scenes]
