"""Identity stripping. Runs before ANY text reaches an LLM (the router enforces it).

Who someone is (name, country, org, email, phone, handle, user id) must not change
how their work is judged. We replace every identity with a neutral role token
([CLIENT], [WORKER], [REVIEWER_1], [COUNTRY_1] ...), so two deals that differ only
in who is involved produce byte-identical prompts. The swap test in
tests/test_deals_identity.py proves that.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL = re.compile(r"https?://\S+|www\.\S+")
PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)")
HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{2,30}")
# Gendered words leak identity just like names do; neutralise them too.
GENDERED = {
    "he": "they", "she": "they", "him": "them", "her": "their", "his": "their", "hers": "theirs",
    "mr": "", "mrs": "", "ms": "", "miss": "", "sir": "", "madam": "",
}
GENDER_RE = re.compile(r"\b(" + "|".join(GENDERED) + r")\b\.?", re.I)

# Country / nationality words are stripped even when not declared on the deal.
COUNTRIES = [
    "india", "indian", "united states", "usa", "american", "united kingdom", "uk", "british", "pakistan", "pakistani",
    "bangladesh", "bangladeshi", "nigeria", "nigerian", "philippines", "filipino", "germany", "german", "canada",
    "canadian", "brazil", "brazilian", "china", "chinese", "kenya", "kenyan", "france", "french", "japan", "japanese",
    "australia", "australian", "mexico", "mexican", "egypt", "egyptian", "indonesia", "indonesian", "vietnam", "vietnamese",
]


@dataclass
class Redactor:
    """Built from the deal's parties. `redact` is pure; `restore` maps tokens back for display only."""

    names: dict[str, str] = field(default_factory=dict)  # literal -> token
    _country_tokens: dict[str, str] = field(default_factory=dict)

    @classmethod
    def for_deal(cls, terms: dict, reviewers: list[str] | None = None, extra: dict[str, str] | None = None) -> "Redactor":
        r = cls()
        for role in ("client", "worker"):
            p = terms.get(role) or {}
            tok = f"[{role.upper()}]"
            for k in ("displayName", "userId", "paypalEmail", "org"):
                if p.get(k):
                    r.add(p[k], tok)
            if p.get("country"):
                r.add_country(p["country"])
        for m in terms.get("milestones", []):
            for i, pay in enumerate(m.get("payees", []) or []):
                for k in ("displayName", "userId", "email"):
                    if pay.get(k):
                        r.names.setdefault(pay[k], f"[PAYEE_{i + 1}]")
        for i, name in enumerate(reviewers or []):
            r.add(name, f"[REVIEWER_{i + 1}]")
        for lit, tok in (extra or {}).items():
            r.add(lit, tok)
        return r

    def add(self, literal: str, token: str) -> None:
        literal = (literal or "").strip()
        if len(literal) < 2:
            return
        self.names[literal] = token
        parts = literal.split()
        if len(parts) > 1:  # "Asha Rao" also hides "Asha" and "Rao" alone
            for p in parts:
                if len(p) > 2:
                    self.names.setdefault(p, token)

    def add_country(self, country: str) -> None:
        c = country.strip().lower()
        if c and c not in self._country_tokens:
            self._country_tokens[c] = f"[COUNTRY_{len(self._country_tokens) + 1}]"

    def redact(self, text: str) -> str:
        if not text:
            return text
        out = EMAIL.sub("[EMAIL]", text)
        out = URL.sub("[URL]", out)
        out = PHONE.sub("[PHONE]", out)
        out = HANDLE.sub("[HANDLE]", out)
        for lit in sorted(self.names, key=len, reverse=True):
            out = re.sub(r"(?<!\w)" + re.escape(lit) + r"(?!\w)", self.names[lit], out, flags=re.I)
        # declared countries first, then any other country word -> one neutral token
        for c, tok in self._country_tokens.items():
            out = re.sub(r"\b" + re.escape(c) + r"\b", "[COUNTRY]", out, flags=re.I)
        for c in sorted(COUNTRIES, key=len, reverse=True):
            out = re.sub(r"\b" + re.escape(c) + r"\b", "[COUNTRY]", out, flags=re.I)
        out = GENDER_RE.sub(lambda m: GENDERED[m.group(1).lower()], out)
        return re.sub(r"[ \t]{2,}", " ", out)

    def redact_obj(self, obj):
        if isinstance(obj, str):
            return self.redact(obj)
        if isinstance(obj, list):
            return [self.redact_obj(v) for v in obj]
        if isinstance(obj, dict):
            return {k: self.redact_obj(v) for k, v in obj.items() if k not in IDENTITY_KEYS}
        return obj

    def restore(self, text: str) -> str:
        """For showing an agent's note to the people on the deal. Never fed back to an LLM."""
        rev: dict[str, str] = {}
        for lit, tok in self.names.items():
            if tok not in rev or len(lit) > len(rev[tok]):
                rev[tok] = lit
        for tok, lit in rev.items():
            text = text.replace(tok, lit)
        return text


# Keys that are dropped entirely from any object sent to an LLM.
IDENTITY_KEYS = {"displayName", "userId", "paypalEmail", "email", "country", "orgId", "authorId", "author", "phone", "avatar"}

LEAK_PATTERNS = [EMAIL, PHONE]


def assert_clean(text: str, red: Redactor | None = None) -> None:
    """Last line of defence inside the router: refuse to send text that still carries identity."""
    for p in LEAK_PATTERNS:
        if p.search(text):
            raise IdentityLeak(f"identity pattern {p.pattern[:20]}... found in LLM input")
    if red is not None:
        low = text.lower()
        for lit in red.names:
            if len(lit) > 2 and re.search(r"(?<!\w)" + re.escape(lit.lower()) + r"(?!\w)", low):
                raise IdentityLeak("a party name is still present in LLM input")


class IdentityLeak(RuntimeError):
    pass
