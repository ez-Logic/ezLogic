"""Postgres access for chat turns and stored Lean code."""

import os
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from agent.graph import ProofGraph

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def _database_url() -> str:
    # Every lookup uses the same connection string. Fail before opening a socket
    # when it was never configured.
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def _connect():
    # dict_row makes fetchone() return {"column": value} instead of a tuple.
    return psycopg.AsyncConnection.connect(_database_url(), row_factory=dict_row)


def _str(value: UUID | datetime | str) -> str:
    # Callers return JSON. Postgres gives back uuid and timestamptz objects.
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


async def init_db() -> None:
    """Create the tables in schema.sql. Safe to run more than once."""
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    # Run each idempotent schema statement, including additive migrations.
    statements = [part.strip() for part in sql.split(";") if part.strip()]
    async with await _connect() as conn:
        async with conn.cursor() as cur:
            for statement in statements:
                await cur.execute(statement)


async def find_response(
    user_token: str, chat_id: str, model: str, query: str
) -> dict[str, str] | None:
    """Newest stored Lean source for this exact text, or None."""
    # Cache lookup for allowBuild false. Same text with a new build stays a
    # second row, so the newest created_at wins.
    async with await _connect() as conn:
        cur = await conn.execute(
            """
            select q.query_id, q.response
            from chat_turns t
            join queries q on q.query_id = t.query_id
            where t.user_token = %s
              and t.chat_id = %s
              and q.model = %s
              and q.query = %s
            order by t.created_at desc
            limit 1
            """,
            (user_token, chat_id, model, query),
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return {"query_id": _str(row["query_id"]), "response": row["response"]}


async def insert_turn(
    user_token: str,
    chat_id: str,
    model: str,
    query: str,
    response: str,
    messages: list[dict[str, Any]],
    graph: ProofGraph | None = None,
    account_id: str | None = None,
) -> str:
    """Store one build and return its query_id. All inserts commit together.

    `account_id` is the signed-in user's id, or None for a guest. Only a signed-in
    user's chat gets a `chats` row.
    """
    async with await _connect() as conn:
        # One transaction: a queries row is not kept without its chat_turns row.
        async with conn.transaction():
            cur = await conn.execute(
                """
                insert into queries (model, query, response, messages)
                values (%s, %s, %s, %s)
                returning query_id
                """,
                (model, query, response, Jsonb(messages)),
            )
            row = await cur.fetchone()
            query_id = row["query_id"]
            if graph is not None:
                await _write_graph(conn, query_id, graph)
            # chat_turns is the list for this token and chat. query_id points
            # at the Lean source just inserted.
            await conn.execute(
                """
                insert into chat_turns (user_token, chat_id, query_id)
                values (%s, %s, %s)
                """,
                (user_token, chat_id, query_id),
            )
            if account_id is not None:
                await _touch_chat(conn, account_id, chat_id, query)
    return _str(query_id)


CHAT_TITLE_MAX = 48


def _chat_title(query: str) -> str:
    """First non-empty line of the opening message, cut like the frontend's chat titles."""
    title = next((line.strip() for line in query.splitlines() if line.strip()), "New proof")
    return title if len(title) <= CHAT_TITLE_MAX else title[: CHAT_TITLE_MAX - 1] + "…"


async def _touch_chat(conn, account_id: str, chat_id: str, query: str) -> None:
    """Create the account's chat, or mark it as just used."""
    # Selecting from users skips the row, instead of failing the whole turn, when the
    # account was deleted but its cookie is still valid. The final `where` leaves a
    # chat that belongs to someone else untouched.
    await conn.execute(
        """
        insert into chats (chat_id, user_id, title)
        select %s, user_id, %s from users where user_id = %s
        on conflict (chat_id) do update set updated_at = now()
        where chats.user_id = excluded.user_id
        """,
        (chat_id, _chat_title(query), account_id),
    )


async def list_chats(user_id: str) -> list[dict[str, str]]:
    """The signed-in user's chats, most recently used first."""
    async with await _connect() as conn:
        cur = await conn.execute(
            """
            select chat_id, title, created_at, updated_at
            from chats
            where user_id = %s
            order by updated_at desc
            """,
            (user_id,),
        )
        rows = await cur.fetchall()
    return [{key: _str(value) for key, value in row.items()} for row in rows]


async def _write_graph(conn, query_id: str | UUID, graph: ProofGraph) -> None:
    graph = ProofGraph.model_validate(graph.model_dump())
    async with conn.cursor() as cur:
        await cur.executemany(
            """insert into proof_nodes
                  (query_id, node_id, depends_on_ids, lean_name, statement, kind, proof_dependency_ids)
               values (%s, %s, %s, %s, %s, %s, %s)""",
            [(query_id, n.node_id, n.depends_on_ids, n.lean_name, n.statement, n.kind, n.proof_dependency_ids)
             for n in graph.nodes],
        )
    await conn.execute(
        "update queries set root_node_id = %s where query_id = %s", (graph.root_node_id, query_id)
    )


async def get_graph_source(user_token: str, query_id: str) -> str | None:
    async with await _connect() as conn:
        cur = await conn.execute(
            """select q.response from queries q where q.query_id = %s
               and exists (select 1 from chat_turns t where t.query_id = q.query_id and t.user_token = %s)""",
            (query_id, user_token),
        )
        row = await cur.fetchone()
    return row["response"] if row else None


async def save_missing_graph(user_token: str, query_id: str, response: str, graph: ProofGraph) -> None:
    """Attach or upgrade a derived graph if the checked snapshot still matches."""
    async with await _connect() as conn:
        cur = await conn.execute(
            """select q.root_node_id from queries q
               where q.query_id = %s and q.response = %s
               and exists (select 1 from chat_turns t where t.query_id = q.query_id and t.user_token = %s)
               for update of q""",
            (query_id, response, user_token),
        )
        row = await cur.fetchone()
        if row is None:
            return
        if row["root_node_id"] is not None:
            # Read after acquiring the query lock to observe any concurrent upgrade.
            cur = await conn.execute(
                "select kind from proof_nodes where query_id = %s and node_id = %s",
                (query_id, row["root_node_id"]),
            )
            root = await cur.fetchone()
            if root and root["kind"] == "theorem":
                return
            await conn.execute("delete from proof_nodes where query_id = %s", (query_id,))
        await _write_graph(conn, query_id, graph)


async def get_graph(user_token: str, query_id: str) -> dict | None:
    """Return only this guest's immutable saved graph; absent and forbidden are both 404."""
    async with await _connect() as conn:
        cur = await conn.execute(
            """select q.root_node_id, n.node_id, n.depends_on_ids, n.lean_name, n.statement,
                      n.kind, n.proof_dependency_ids
               from queries q join proof_nodes n on n.query_id = q.query_id
               where q.query_id = %s and q.root_node_id is not null
                 and exists (select 1 from chat_turns t
                             where t.query_id = q.query_id and t.user_token = %s)
               order by n.node_id""",
            (query_id, user_token),
        )
        rows = await cur.fetchall()
    if not rows:
        return None
    return {
        "query_id": query_id,
        "root_node_id": rows[0]["root_node_id"],
        "nodes": [{k: v for k, v in row.items() if k != "root_node_id"} for row in rows],
    }


async def list_history(user_token: str, chat_id: str) -> list[dict[str, str]]:
    """Every turn for this token and chat, oldest first."""
    # GET /api/history uses this. Order is oldest first so the UI can render
    # the chat from the first build to the last.
    async with await _connect() as conn:
        cur = await conn.execute(
            """
            select q.query_id, q.model, q.query, q.response, t.created_at
            from chat_turns t
            join queries q on q.query_id = t.query_id
            where t.user_token = %s and t.chat_id = %s
            order by t.created_at
            """,
            (user_token, chat_id),
        )
        rows = await cur.fetchall()
    return [
        {
            "query_id": _str(row["query_id"]),
            "model": row["model"],
            "query": row["query"],
            "response": row["response"],
            "created_at": _str(row["created_at"]),
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Accounts (email + password). `email` is stored normalised by the caller.


async def create_user(email: str, password_hash: str) -> dict[str, str] | None:
    """Insert a user and return {user_id, email}, or None if the email is taken."""
    async with await _connect() as conn:
        cur = await conn.execute(
            """
            insert into users (email, password_hash) values (%s, %s)
            on conflict (email) do nothing
            returning user_id, email
            """,
            (email, password_hash),
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return {"user_id": _str(row["user_id"]), "email": row["email"]}


async def get_user_by_email(email: str) -> dict[str, str] | None:
    async with await _connect() as conn:
        cur = await conn.execute(
            "select user_id, email, password_hash from users where email = %s", (email,)
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return {**row, "user_id": _str(row["user_id"])}


async def get_user(user_id: str) -> dict[str, str] | None:
    async with await _connect() as conn:
        cur = await conn.execute(
            "select user_id, email from users where user_id = %s", (user_id,)
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return {"user_id": _str(row["user_id"]), "email": row["email"]}
