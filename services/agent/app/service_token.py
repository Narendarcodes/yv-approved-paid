"""Local verification of the Node-minted service JWT (HS256, iss yv-api, aud yv-internal).

The lean agent on Render cannot call Node's private /internal listener (loopback-only), so for
/v1/chat it verifies the token itself with SERVICE_JWT_SECRET (same value as on the API) and takes
orgId from the verified claims only. Stdlib only: no PyJWT in the lean image."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import time

ISS = "yv-api"
AUD = "yv-internal"


class TokenError(ValueError):
    pass


def _b64(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def verify(token: str, secret: str, *, scope: str | None = None, leeway: int = 30) -> dict:
    if not secret:
        raise TokenError("SERVICE_JWT_SECRET is not configured")
    try:
        h, p, s = token.split(".")
        header, claims = json.loads(_b64(h)), json.loads(_b64(p))
        sig = _b64(s)
    except Exception as e:
        raise TokenError("malformed token") from e
    if header.get("alg") != "HS256":
        raise TokenError("unexpected alg")
    want = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, want):
        raise TokenError("bad signature")
    now = time.time()
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] + leeway < now:
        raise TokenError("expired")
    if isinstance(claims.get("nbf"), (int, float)) and claims["nbf"] - leeway > now:
        raise TokenError("not yet valid")
    aud = claims.get("aud")
    if claims.get("iss") != ISS or (aud != AUD and not (isinstance(aud, list) and AUD in aud)):
        raise TokenError("wrong issuer or audience")
    if not claims.get("orgId"):
        raise TokenError("no orgId")
    if scope and scope not in (claims.get("scopes") or []):
        raise TokenError(f"missing scope {scope}")
    return claims
