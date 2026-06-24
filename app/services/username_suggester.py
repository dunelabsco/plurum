"""Username suggestion generator — pure, no I/O.

Reddit-style: a big keyspace of adjective-noun-digit handles plus
seed-derived variants, so a batched availability check almost always
yields free names on the first try. Every emitted candidate already
satisfies the agents.username regex, so callers never need to re-validate.
"""

import random
import re
from typing import List

_USERNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$")

_ADJECTIVES = [
    "swift", "calm", "bold", "bright", "clever", "quiet", "brave", "keen",
    "lucid", "nimble", "stellar", "cosmic", "amber", "cobalt", "verdant",
    "sly", "wry", "deft", "vivid", "lunar",
]
_NOUNS = [
    "otter", "falcon", "cedar", "comet", "harbor", "lynx", "maple", "raven",
    "delta", "quartz", "willow", "ember", "pike", "heron", "birch", "onyx",
    "vector", "atlas", "cipher", "magnet",
]


def normalize_username(raw: str) -> str:
    """Lowercase, replace runs of illegal chars with '-', trim to a valid core."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9_-]+", "-", s)
    s = re.sub(r"^[^a-z0-9]+", "", s)
    s = re.sub(r"[^a-z0-9]+$", "", s)
    return s[:50]


def _valid(name: str) -> bool:
    return bool(name) and 3 <= len(name) <= 50 and bool(_USERNAME_RE.match(name))


def generate_candidates(seed: str = "", count: int = 6) -> List[str]:
    """Return up to `count` distinct, regex-valid username candidates."""
    out: List[str] = []
    seen = set()

    def add(name: str) -> None:
        if _valid(name) and name not in seen:
            seen.add(name)
            out.append(name)

    base = normalize_username(seed)
    if base and len(base) >= 3:
        add(base)
        add(f"{base}-{random.choice(_NOUNS)}")
        add(f"{base}{random.randint(10, 99)}")

    # Fill the rest with adjective-noun-digit handles.
    attempts = 0
    while len(out) < count and attempts < count * 20:
        attempts += 1
        name = f"{random.choice(_ADJECTIVES)}-{random.choice(_NOUNS)}-{random.randint(10, 999)}"
        add(name)

    return out[:count]
