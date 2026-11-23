"""Signed-in user sessions (email + password accounts).

Mirrors guest_session.py: an HttpOnly JWT cookie scoped to /api. Signing in is
optional; `ensure_session` falls back to the guest session when there's no valid
user cookie, and puts whichever id applies on `request.state.user_token`.
"""

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Request, Response

from config import Config
from guest_session import ensure_guest_session

COOKIE_NAME = "ezlogic_user"
USER_ISSUER = "ezlogic-user"  # distinct from the guest issuer, so a guest token never passes
SESSION_TTL = timedelta(days=7)


def issue_user_cookie(response: Response, user_id: str) -> None:
    token = jwt.encode(
        {
            "sub": user_id,
            "iss": USER_ISSUER,
            "exp": datetime.now(timezone.utc) + SESSION_TTL,
        },
        Config.GUEST_JWT_SECRET,
        algorithm="HS256",
    )
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=int(SESSION_TTL.total_seconds()),
        path="/api",
        httponly=True,
        secure=Config.GUEST_COOKIE_SECURE,
        samesite="lax",
    )


def clear_user_cookie(response: Response) -> None:
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/api",
        httponly=True,
        secure=Config.GUEST_COOKIE_SECURE,
        samesite="lax",
    )


def read_user_id(request: Request) -> str | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    try:
        claims = jwt.decode(
            token,
            Config.GUEST_JWT_SECRET,
            algorithms=["HS256"],
            issuer=USER_ISSUER,
            options={"require": ["sub", "exp", "iss"]},
        )
    except jwt.InvalidTokenError:
        return None
    return claims["sub"]


def ensure_session(request: Request, response: Response) -> None:
    """The signed-in user's id if there is one, else the (possibly new) guest id."""
    user_id = read_user_id(request)
    if user_id:
        request.state.user_token = user_id
        return
    ensure_guest_session(request, response)
    request.state.user_token = request.state.guest_id
