"""Password hashing with the stdlib's scrypt (no extra dependency in the image).

Stored format: ``scrypt$n$r$p$<salt b64>$<hash b64>``.
"""

import base64
import hashlib
import hmac
import secrets

_N, _R, _P = 2**14, 8, 1
_SALT_BYTES = 16
_KEY_BYTES = 64


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
        maxmem=128 * n * r * 2, dklen=_KEY_BYTES,
    )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    key = _derive(password, salt, _N, _R, _P)
    return f"scrypt${_N}${_R}${_P}${_b64(salt)}${_b64(key)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, key = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(key, validate=True)
        actual = _derive(password, base64.b64decode(salt, validate=True), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# Checked against when the email has no account, so a login for an unknown email
# takes as long as one with a wrong password.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
