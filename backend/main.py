import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, EmailStr

from agent import AgentResult, ExplainerAgent, ProofAgent, Workspace, WorkspaceError
from agent import envelope, lean
from agent.graph import GraphResponse, extract_graph
from config import Config
from auth import clear_user_cookie, ensure_session, issue_user_cookie, read_user_id
from passwords import DUMMY_HASH, hash_password, verify_password

import db

# Only the root logger needs a handler; every module below logs through
# logging.getLogger(__name__), e.g. "main", "agent.agent", "agent.lean". Everything
# ends up in this process's terminal -- there is no log file (see backend/README.md).
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("httpx").setLevel(logging.WARNING)  # the OpenAI client's HTTP logs are noisy at INFO

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.init_db()
    # Best-effort and non-blocking: starts the Lean REPL and preloads Mathlib (if
    # applicable) in the background, so the first chat request isn't the one that
    # pays for it. See agent/lean.py's warm_up().
    asyncio.create_task(_warm_up_lean())
    yield


async def _warm_up_lean() -> None:
    try:
        t0 = time.monotonic()
        await lean.warm_up()
        log.info("Lean REPL warm-up finished in %.1fs", time.monotonic() - t0)
    except Exception:
        log.exception("Lean REPL warm-up failed; will retry lazily on first use")


app = FastAPI(
    title=Config.API_TITLE,
    description="LLM-powered Lean proof writing and verification",
    version=Config.API_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[Config.FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

workspace = Workspace(Config.WORKSPACE_DIR)

LEAN_FILE_TOOLS = {"check_lean_file", "write_file", "edit_file"}


class ChatRequest(BaseModel):
    chat_id: UUID
    text: str
    model: str | None = None  # override ANTHROPIC_MODEL
    allowBuild: bool = False


class HistoryTurn(BaseModel):
    query_id: str
    model: str
    query: str
    response: str  # the Lean source (decoded from the stored envelope)
    created_at: str
    # The explanation as a ```json {intro, steps} block for the frontend's
    # fromReply, or None if this turn has no stored explanation.
    reply: str | None = None


class HistoryResponse(BaseModel):
    turns: list[HistoryTurn]


class ChatSummary(BaseModel):
    chat_id: str
    title: str
    created_at: str
    updated_at: str


class ChatsResponse(BaseModel):
    chats: list[ChatSummary]


class SnippetRequest(BaseModel):
    code: str


class FileRequest(BaseModel):
    path: str


def _user_id(request: Request) -> str:
    """Signed-in user id, else the guest id; set by auth.ensure_session."""
    return request.state.user_token


def _extract_lean(result: AgentResult, proof_workspace: Workspace) -> tuple[str | None, str | None]:
    """Select a proof attempt and its file path, if any. Probes stay in the trace."""
    snippet: str | None = None
    for call in reversed(result.tool_calls):
        name = call.get("name")
        args = call.get("arguments") or {}
        path = args.get("path")
        if name in LEAN_FILE_TOOLS and isinstance(path, str) and path.endswith(".lean"):
            try:
                code = proof_workspace.read_file(path)
            except WorkspaceError:
                continue
            if lean.is_proof_candidate(code):
                return code, path
        if name == "check_lean_snippet" and snippet is None:
            code = args.get("code")
            if isinstance(code, str) and lean.is_proof_candidate(code):
                snippet = code
    return snippet, None


def _final_source_check(calls: list[dict], code: str, path: str | None) -> dict | None:
    """Find Lean's latest check of the chosen file or proof snippet."""
    source_hash = lean.source_hash(code)
    for call in reversed(calls):
        arguments = call.get("arguments") or {}
        if path is not None:
            matches = call.get("name") == "check_lean_file" and arguments.get("path") == path
        else:
            matches = call.get("name") == "check_lean_snippet" and arguments.get("code") == code
        if matches:
            checked = call.get("result") or {}
            return call if checked.get("source_hash") == source_hash else None
    return None


JSON_FENCE = re.compile(r"```json\s*[\s\S]*?```")


def _compose_reply(writer_reply: str, explanation: dict | None) -> str:
    """The `reply` sent to the frontend.

    With an explanation, the writer's own ```json blocks are dropped (the
    frontend's fromReply uses the *first* one) and the explanation is appended
    as the json block it renders as step cards. Without one, the writer's
    reply is sent unchanged.
    """
    if explanation is None:
        return writer_reply
    prose = JSON_FENCE.sub("", writer_reply).strip()
    fence = envelope.explanation_fence(explanation)
    return f"{prose}\n\n{fence}" if prose else fence


def _stored_turn(response: str) -> tuple[str, str]:
    """`(lean, reply)` for a stored `queries.response`: reply is the explanation's
    json block, or the Lean itself when there is none (what a cache hit always
    sent before explanations existed, which the frontend treats as "no reply")."""
    lean_src, explanation = envelope.decode(response)
    reply = envelope.explanation_fence(explanation) if explanation else lean_src
    return lean_src, reply


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "ezLogic Backend"}


@app.post(
    "/api/session",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(ensure_session)],
)
async def start_guest_session() -> None:
    """Validate or issue the guest session cookie."""


# ---------------------------------------------------------------------------
# Email + password accounts (optional; guests keep working without one)

PASSWORD_MIN, PASSWORD_MAX = 8, 256


class Credentials(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str


class AuthResponse(BaseModel):
    user: UserOut | None


def _normalise_email(email: str) -> str:
    return email.strip().lower()


def _user_out(row: dict) -> UserOut:
    return UserOut(id=row["user_id"], email=row["email"])


def _db_unavailable(e: Exception) -> HTTPException:
    log.error("auth db error: %s", e)
    return HTTPException(status_code=503, detail="Account database is unavailable")


@app.post("/api/auth/signup", response_model=AuthResponse, status_code=201)
async def signup(body: Credentials, response: Response):
    if not PASSWORD_MIN <= len(body.password) <= PASSWORD_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"Password must be {PASSWORD_MIN}-{PASSWORD_MAX} characters",
        )
    password_hash = await asyncio.to_thread(hash_password, body.password)
    try:
        user = await db.create_user(_normalise_email(body.email), password_hash)
    except (RuntimeError, psycopg.Error) as e:
        raise _db_unavailable(e)
    if user is None:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    issue_user_cookie(response, user["user_id"])
    return AuthResponse(user=_user_out(user))


@app.post("/api/auth/login", response_model=AuthResponse)
async def login(body: Credentials, response: Response):
    try:
        user = await db.get_user_by_email(_normalise_email(body.email))
    except (RuntimeError, psycopg.Error) as e:
        raise _db_unavailable(e)
    stored = user["password_hash"] if user else DUMMY_HASH
    ok = await asyncio.to_thread(verify_password, body.password[:PASSWORD_MAX], stored)
    if user is None or not ok:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    issue_user_cookie(response, user["user_id"])
    return AuthResponse(user=_user_out(user))


@app.post("/api/auth/logout", status_code=204, response_class=Response)
async def logout(response: Response) -> None:
    clear_user_cookie(response)


@app.get("/api/auth/me", response_model=AuthResponse)
async def me(request: Request):
    user_id = read_user_id(request)
    if user_id is None:
        return AuthResponse(user=None)
    try:
        user = await db.get_user(user_id)
    except (RuntimeError, psycopg.Error) as e:
        raise _db_unavailable(e)
    return AuthResponse(user=_user_out(user) if user else None)


@app.post(
    "/api/chat",
    response_class=StreamingResponse,
    dependencies=[Depends(ensure_session)],
)
async def chat(body: ChatRequest, request: Request, session_response: Response):
    """Run the proof agent for one user turn, streaming events as SSE.

    Each event is a `data: {json}` line. Agent events (`token`,
    `tool_call_start`, `tool_result`) are forwarded as-is; see
    `ProofAgent.stream`. The last event is always either

      {"type": "done", "cached": bool, "query_id": str | None, "response": str,
       "reply": str, "finished": bool, "tool_calls": list}

    or, on failure mid-stream, `{"type": "error", "detail": str}`.
    A cache hit (allowBuild false) sends only the `done` event.
    """
    user = _user_id(request)
    chat_id = str(body.chat_id)
    model = body.model or Config.ANTHROPIC_MODEL
    log.info(
        "chat request chat_id=%s user=%s model=%s allowBuild=%s len(text)=%d",
        chat_id, user, model, body.allowBuild, len(body.text),
    )

    try:
        if not body.allowBuild:
            hit = await db.find_response(user, chat_id, model, body.text)
            if hit is not None:
                log.info("chat cache hit chat_id=%s query_id=%s", chat_id, hit["query_id"])
                lean_src, reply = _stored_turn(hit["response"])
                return _stream(
                    _single(
                        {
                            "type": "done",
                            "cached": True,
                            "query_id": hit["query_id"],
                            "response": lean_src,
                            "reply": reply,
                            "finished": True,
                            "tool_calls": [],
                        }
                    ),
                    session_response,
                )

        turns = await db.list_history(user, chat_id)
    except (RuntimeError, psycopg.Error) as e:
        log.error("chat db error chat_id=%s: %s", chat_id, e)
        raise HTTPException(status_code=503, detail=f"Database error: {e}")

    try:
        agent = ProofAgent(workspace, model=model)
    except RuntimeError as e:
        log.error("chat agent init failed chat_id=%s: %s", chat_id, e)
        raise HTTPException(status_code=503, detail=str(e))

    async def events() -> AsyncIterator[str]:
        t0 = time.monotonic()
        try:
            async for event in agent.stream(body.text, turns):
                if event["type"] != "done":
                    yield _sse(event)
                    continue

                result = AgentResult(
                    reply=event["reply"],
                    messages=event["messages"],
                    tool_calls=event["tool_calls"],
                    finished=event["finished"],
                )
                response, lean_file = _extract_lean(result, workspace)
                check = _final_source_check(result.tool_calls, response, lean_file) if response else None
                verified = bool(result.finished and check and check["result"].get("ok") is True)
                attempted_lean = any(
                    c.get("name") in LEAN_FILE_TOOLS or c.get("name") == "check_lean_snippet"
                    for c in result.tool_calls
                )
                finished = result.finished and (response is not None or not attempted_lean)
                writer_reply = result.reply
                if response is None and attempted_lean:
                    writer_reply = "The writer stopped before submitting a Lean proof. See “How this was checked” for the tool results."

                # Explaining agent: break the final Lean into step cards that
                # point at line ranges. Runs for unfinished (unverified) runs
                # too; any failure just leaves the writer's reply as it was.
                explanation: dict | None = None
                if response is not None and response.strip():
                    t1 = time.monotonic()
                    try:
                        explainer = ExplainerAgent(Config.ANTHROPIC_EXPLAIN_MODEL or model)
                        async for ev in explainer.stream(
                            body.text,
                            response,
                            writer_reply=writer_reply,
                            tool_calls=[check] if check else [],
                            finished=finished,
                            history=turns,
                        ):
                            if ev["type"] == "explanation":
                                explanation = ev["explanation"]
                            else:
                                yield _sse(ev)
                    except Exception:
                        log.exception("chat explainer failed chat_id=%s", chat_id)
                    log.info(
                        "chat explained chat_id=%s ok=%s elapsed=%.1fs",
                        chat_id, explanation is not None, time.monotonic() - t1,
                    )

                query_id: str | None = None
                if verified and response is not None:
                    # Recheck the exact saved source, then ask Lean for its dependencies.
                    # A failed extraction leaves the original reply/status intact.
                    yield _sse({"type": "tool_call_start", "id": "graph", "name": "extract_dependency_graph"})
                    graph = await extract_graph(response)
                    yield _sse({"type": "tool_result", "id": "graph", "name": "extract_dependency_graph",
                                "arguments": {}, "result": {"ok": graph is not None}})
                    query_id = await db.insert_turn(
                        user, chat_id, model, body.text,
                        envelope.encode(response, explanation), result.messages,
                        graph=graph,
                        account_id=read_user_id(request),
                    )
                log.info(
                    "chat done chat_id=%s finished=%s saved=%s tool_calls=%d elapsed=%.1fs",
                    chat_id, result.finished, query_id is not None, len(result.tool_calls),
                    time.monotonic() - t0,
                )
                yield _sse(
                    {
                        "type": "done",
                        "cached": False,
                        "query_id": query_id,
                        "response": response or "",
                        "reply": _compose_reply(writer_reply, explanation),
                        "finished": finished,
                        "verified": verified,
                        "lean_file": lean_file,
                        "tool_calls": result.tool_calls,
                    }
                )
        except Exception as e:  # status code is already sent; report in-band
            log.exception("chat stream failed chat_id=%s after %.1fs", chat_id, time.monotonic() - t0)
            yield _sse({"type": "error", "detail": f"{type(e).__name__}: {e}"})

    return _stream(events(), session_response)


PROOF_UNAVAILABLE = "This saved proof is unavailable in your guest session. Run the proof again to save it in this session."


@app.get("/api/queries/{query_id}/graph", response_model=GraphResponse | None,
         dependencies=[Depends(ensure_session)])
async def proof_graph(query_id: UUID, request: Request):
    user = _user_id(request)
    key = str(query_id)
    try:
        graph = await db.get_graph(user, key)
        if graph is None and await db.get_graph_source(user, key) is None:
            raise HTTPException(status_code=404, detail=PROOF_UNAVAILABLE)
    except (RuntimeError, psycopg.Error):
        log.exception("Graph database lookup failed")
        raise HTTPException(status_code=503, detail="Graph database is unavailable")
    return graph


@app.post("/api/queries/{query_id}/graph", response_model=GraphResponse,
          dependencies=[Depends(ensure_session)])
async def build_proof_graph(query_id: UUID, request: Request):
    """Build or upgrade a declaration graph from the saved proof using Lean."""
    user = _user_id(request)
    key = str(query_id)
    try:
        saved = await db.get_graph(user, key)
        if saved and GraphResponse.model_validate(saved).has_proof_view:
            return saved
        snapshot = await db.get_graph_source(user, key)
        if snapshot is None:
            raise HTTPException(status_code=404, detail=PROOF_UNAVAILABLE)
        source, _ = envelope.decode(snapshot)
        graph = await extract_graph(source)
        if graph is None:
            raise HTTPException(status_code=422, detail="Lean could not extract a dependency graph from this saved proof.")
        await db.save_missing_graph(user, key, snapshot, graph)
        if saved := await db.get_graph(user, key):
            return saved
        raise HTTPException(status_code=409, detail="The saved proof changed while the graph was being built.")
    except (RuntimeError, psycopg.Error):
        log.exception("Graph database write failed")
        raise HTTPException(status_code=503, detail="Graph database is unavailable")


@app.get("/api/chats", response_model=ChatsResponse)
async def chats(request: Request):
    """The signed-in user's chats, most recently used first. Empty for a guest."""
    user_id = read_user_id(request)
    if user_id is None:
        return ChatsResponse(chats=[])
    try:
        rows = await db.list_chats(user_id)
    except (RuntimeError, psycopg.Error) as e:
        log.error("chats db error: %s", e)
        raise HTTPException(status_code=503, detail=f"Database error: {e}")
    return ChatsResponse(chats=[ChatSummary(**row) for row in rows])


@app.get(
    "/api/history",
    response_model=HistoryResponse,
    dependencies=[Depends(ensure_session)],
)
async def history(chat_id: UUID, request: Request):
    """Every stored turn for this guest and chat, oldest first."""
    try:
        turns = await db.list_history(_user_id(request), str(chat_id))
    except (RuntimeError, psycopg.Error) as e:
        log.error("history db error chat_id=%s: %s", chat_id, e)
        raise HTTPException(status_code=503, detail=f"Database error: {e}")
    out: list[HistoryTurn] = []
    for turn in turns:
        lean_src, explanation = envelope.decode(turn["response"])
        out.append(
            HistoryTurn(
                **{**turn, "response": lean_src},
                reply=envelope.explanation_fence(explanation) if explanation else None,
            )
        )
    return HistoryResponse(turns=out)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


async def _single(event: dict) -> AsyncIterator[str]:
    yield _sse(event)


# A proof can go quiet for a while (the first Mathlib load, a long Lean check).
# Proxies in front of a hosted backend may drop a stream that sends nothing, so
# _stream sends an SSE comment after this many quiet seconds; the frontend's
# createSSEParser ignores lines that aren't `data:`.
KEEPALIVE_SECONDS = 15.0
KEEPALIVE = ": ping\n\n"


async def _with_keepalive(
    body: AsyncIterator[str], interval: float = KEEPALIVE_SECONDS
) -> AsyncIterator[str]:
    """`body`'s chunks, plus KEEPALIVE whenever `body` is quiet for `interval` s.

    `body` runs to completion in one task of its own (so context managers inside
    it enter and exit in the same task); this generator relays what it yields.
    """
    queue: asyncio.Queue = asyncio.Queue()
    end = object()

    async def pump() -> None:
        try:
            async for chunk in body:
                queue.put_nowait(chunk)
        finally:
            queue.put_nowait(end)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield KEEPALIVE
                continue
            if chunk is end:
                break
            yield chunk
        await task  # re-raise anything `body` raised
    finally:
        if not task.done():  # the client went away mid-stream
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


def _stream(body: AsyncIterator[str], session_response: Response) -> StreamingResponse:
    stream = StreamingResponse(
        _with_keepalive(body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
    for cookie in session_response.headers.getlist("set-cookie"):
        stream.headers.append("set-cookie", cookie)
    return stream


@app.get("/api/files")
async def list_files():
    return {"files": workspace.list_files()}


@app.get("/api/files/{path:path}")
async def read_file(path: str):
    try:
        return {"path": path, "content": workspace.read_file(path)}
    except WorkspaceError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/verify/snippet")
async def verify_snippet(request: SnippetRequest):
    """Check a short Lean snippet with the lean-interact REPL."""
    return (await lean.check_snippet(request.code)).to_dict()


@app.post("/api/verify/file")
async def verify_file(request: FileRequest):
    """Check a workspace file with the lean-interact REPL."""
    try:
        return (await lean.check_file(workspace, request.path)).to_dict()
    except WorkspaceError as e:
        raise HTTPException(status_code=400, detail=str(e))


# --- The built frontend --------------------------------------------------------------
# In the hosted image (see the root Dockerfile) the SvelteKit build is copied to
# Config.STATIC_DIR and served from this app, so the site and /api share one origin
# (a first-party guest cookie, no CORS or proxy). Locally there is no build there,
# and the Vite dev server serves the frontend as before. Registered last, so every
# route above takes precedence.

def _site_file(root: Path, path: str) -> Path | None:
    """The file under `root` for a URL path, if one exists (never outside `root`)."""
    if not path:
        return None
    target = (root / path).resolve()
    return target if target.is_file() and root in target.parents else None


def mount_site(target: FastAPI, root: Path) -> bool:
    """Serve the built frontend in `root` from `target`, after its other routes.
    Returns False (and does nothing) if `root` has no index.html."""
    root = root.resolve()
    if not (root / "index.html").is_file():
        return False

    @target.get("/{path:path}", include_in_schema=False)
    async def site(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        found = _site_file(root, path)
        if found is not None:
            immutable = path.startswith("_app/immutable/")
            cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
            return FileResponse(found, headers={"Cache-Control": cache})
        # Single-page app: every other path gets the shell (adapter-static's fallback).
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    return True


if mount_site(app, Config.STATIC_DIR):
    log.info("serving the frontend from %s", Config.STATIC_DIR)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
