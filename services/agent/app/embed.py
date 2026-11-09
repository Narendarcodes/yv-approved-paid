"""Dependency-free hashing-trick embedding (unigrams + bigrams), shared by the Qdrant index
(full image) and the in-process index (lean image). Swap via EMBED_MODEL in the full image."""
from __future__ import annotations
import hashlib
import math
import re

_TOKEN = re.compile(r"[\w']+", re.UNICODE)


def hash_embed(text: str, dim: int) -> list[float]:
    v = [0.0] * dim
    toks = [t.lower() for t in _TOKEN.findall(text)]
    feats = toks + [a + "_" + b for a, b in zip(toks, toks[1:])]
    for f in feats:
        h = int(hashlib.md5(f.encode()).hexdigest(), 16)
        v[h % dim] += 1.0 if (h >> 64) & 1 else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]
