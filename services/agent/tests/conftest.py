import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("LLM_MODEL", "stub")
os.environ.setdefault("QDRANT_URL", ":memory:")
os.environ.pop("STT_URL", None)
os.environ["REDIS_URL"] = ""
