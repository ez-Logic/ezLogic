"""Email + password accounts: hashing, the user cookie, and (opt-in) the endpoints."""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import httpx
import jwt
import pytest

import auth
from config import Config
from guest_session import GUEST_ISSUER
from passwords import hash_password, verify_password


def test_password_round_trip_and_rejects_wrong_or_tampered():
    stored = hash_password("correct horse")
    assert stored.startswith("scrypt$")
    assert verify_password("correct horse", stored)
    assert not verify_password("wrong horse", stored)
    assert hash_password("correct horse") != stored  # fresh salt each time
    assert not verify_password("correct horse", stored[:-4] + "AAAA")
    assert not verify_password("correct horse", "garbage")
    assert not verify_password("correct horse", "bcrypt$1$2$3$4$5")


def _request(token: str | None):
    return SimpleNamespace(cookies={auth.COOKIE_NAME: token} if token else {})


def _token(iss: str, exp_delta: timedelta, sub: str = "u-1") -> str:
    return jwt.encode(
        {"sub": sub, "iss": iss, "exp": datetime.now(timezone.utc) + exp_delta},
        Config.GUEST_JWT_SECRET,
        algorithm="HS256",
    )


def test_read_user_id_accepts_only_valid_user_tokens():
    assert auth.read_user_id(_request(_token(auth.USER_ISSUER, timedelta(hours=1)))) == "u-1"
    assert auth.read_user_id(_request(None)) is None
    assert auth.read_user_id(_request("not-a-jwt")) is None
    assert auth.read_user_id(_request(_token(auth.USER_ISSUER, timedelta(hours=-1)))) is None
    # A guest token, even signed with the same secret, is not a user session.
    assert auth.read_user_id(_request(_token(GUEST_ISSUER, timedelta(hours=1)))) is None


@pytest.mark.skipif(os.getenv("RUN_GRAPH_DB_TESTS") != "1", reason="Requires local PostgreSQL")
def test_signup_login_logout_and_history_isolation():
    import db
    import main

    async def check():
        await db.init_db()
        email = f"auth-test-{uuid4()}@Example.com"
        password = "s3cret-password"
        chat_id = str(uuid4())
        transport = httpx.ASGITransport(app=main.app)
        async with (
            httpx.AsyncClient(transport=transport, base_url="http://test") as user,
            httpx.AsyncClient(transport=transport, base_url="http://test") as guest,
        ):
            assert (await user.get("/api/auth/me")).json() == {"user": None}
            assert (await user.post("/api/auth/signup", json={"email": email, "password": "short"})).status_code == 422

            r = await user.post("/api/auth/signup", json={"email": email, "password": password})
            assert r.status_code == 201
            me = r.json()["user"]
            assert me["email"] == email.lower()
            assert (await user.get("/api/auth/me")).json() == {"user": me}

            dup = await guest.post("/api/auth/signup", json={"email": email.upper(), "password": password})
            assert dup.status_code == 409
            bad = await guest.post("/api/auth/login", json={"email": email, "password": "nope-nope"})
            assert bad.status_code == 401
            unknown = await guest.post("/api/auth/login", json={"email": f"x-{uuid4()}@example.com", "password": password})
            assert unknown.status_code == 401 and unknown.json() == bad.json()

            # A turn stored for the user is visible to them and not to a guest.
            await db.insert_turn(me["id"], chat_id, "auth-test", "q", "snapshot", [])
            assert len((await user.get(f"/api/history?chat_id={chat_id}")).json()["turns"]) == 1
            assert (await guest.get(f"/api/history?chat_id={chat_id}")).json()["turns"] == []

            assert (await user.post("/api/auth/logout")).status_code == 204
            assert (await user.get("/api/auth/me")).json() == {"user": None}
            assert (await user.get(f"/api/history?chat_id={chat_id}")).json()["turns"] == []

            r = await user.post("/api/auth/login", json={"email": email.upper(), "password": password})
            assert r.status_code == 200 and r.json()["user"] == me
            assert len((await user.get(f"/api/history?chat_id={chat_id}")).json()["turns"]) == 1

    asyncio.run(check())


def test_chat_title_is_the_first_line_cut_to_48_characters():
    from db import _chat_title

    assert _chat_title("\n  Prove it  \nmore") == "Prove it"
    assert _chat_title("x" * 48) == "x" * 48
    assert _chat_title("x" * 49) == "x" * 47 + "…"
    assert _chat_title(" \n ") == "New proof"


def test_chats_is_empty_for_a_guest_without_touching_the_database(monkeypatch):
    import main

    async def unexpected(*_args):
        raise AssertionError("a guest has no chats to look up")

    monkeypatch.setattr(main.db, "list_chats", unexpected)

    async def check():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as guest:
            r = await guest.get("/api/chats")
            assert r.status_code == 200 and r.json() == {"chats": []}

    asyncio.run(check())


@pytest.mark.skipif(os.getenv("RUN_GRAPH_DB_TESTS") != "1", reason="Requires local PostgreSQL")
def test_chats_belong_to_the_account_that_saved_them():
    import db
    import main

    async def signup(client):
        r = await client.post(
            "/api/auth/signup",
            json={"email": f"chats-test-{uuid4()}@example.com", "password": "s3cret-password"},
        )
        return r.json()["user"]["id"]

    async def listed(client):
        r = await client.get("/api/chats")
        assert r.status_code == 200
        return [(c["chat_id"], c["title"]) for c in r.json()["chats"]]

    async def save(token, chat_id, query, account_id=None):
        return await db.insert_turn(token, chat_id, "auth-test", query, "snapshot", [], account_id=account_id)

    async def check():
        await db.init_db()
        await db.init_db()  # the schema must be repeatable on an existing database
        first, second = str(uuid4()), str(uuid4())
        transport = httpx.ASGITransport(app=main.app)
        async with (
            httpx.AsyncClient(transport=transport, base_url="http://test") as owner,
            httpx.AsyncClient(transport=transport, base_url="http://test") as other,
            httpx.AsyncClient(transport=transport, base_url="http://test") as guest,
        ):
            owner_id, other_id = await signup(owner), await signup(other)
            assert await listed(owner) == []

            await save(owner_id, first, "First chat", owner_id)
            await save(owner_id, second, "Second chat", owner_id)
            assert await listed(owner) == [(second, "Second chat"), (first, "First chat")]

            # Another turn moves the chat up, without a duplicate or a new title.
            await save(owner_id, first, "A follow-up", owner_id)
            assert await listed(owner) == [(first, "First chat"), (second, "Second chat")]

            # Someone else's turn under the same chat id changes neither list.
            await save(other_id, second, "Takeover", other_id)
            assert await listed(owner) == [(first, "First chat"), (second, "Second chat")]
            assert await listed(other) == []

            # A guest turn gets no chats row.
            await save(str(uuid4()), str(uuid4()), "Guest chat")
            assert await listed(guest) == []

            # A cookie can outlive its account: the turn is still saved.
            gone, gone_chat = str(uuid4()), str(uuid4())
            await save(gone, gone_chat, "Orphan", gone)
            assert len(await db.list_history(gone, gone_chat)) == 1
            assert await db.list_chats(gone) == []

    asyncio.run(check())
