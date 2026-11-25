# ezLogic Backend

FastAPI backend hosting the Lean proof agent.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set ANTHROPIC_API_KEY
python main.py         # http://localhost:8000, docs at /docs
```

Lean must be installed separately via [elan](https://github.com/leanprover/elan) for
verification to work; without it, Lean tools return an "not installed" error and the agent
reports proofs as unverified.

## Database

Chat turns are cached in Postgres (see `database/README.md`). `DATABASE_URL` must point at a
reachable database before the backend will start (`init_db()` runs on startup). For local
development, run Postgres in Docker and point `DATABASE_URL` at it:

```bash
docker run --name ezlogic-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

Also set `GUEST_JWT_SECRET` in `.env` to a persistent random value, or guest sessions
(and their chat history) are invalidated every time the backend restarts.

## Testing the agent from the terminal

```bash
python -m agent                                  # interactive chat (/files, /reset, /exit)
python -m agent "prove that 2 + 2 = 4"           # single prompt
python -m agent --model claude-sonnet-5-5 "..."  # override the Anthropic model
```

Tool calls are printed live as the agent runs them.

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/api/session` | Validate or issue the guest cookie. Returns `204 No Content` |
| POST | `/api/chat` | Run the agent for one turn, streamed as SSE. Body: `{"chat_id": uuid, "text": str, "model": str?, "allowBuild": bool}`. See `database/README.md` for the event stream shape |
| GET | `/api/chats` | The signed-in user's chats, most recently used first. Empty for a guest |
| GET | `/api/history?chat_id=<uuid>` | Every stored turn for this guest and chat, oldest first |
| GET | `/api/files` | List workspace files |
| GET | `/api/files/{path}` | Read a workspace file |
| POST | `/api/verify/file` | Check a workspace file with the lean-interact REPL. Body: `{"path": str}` |
| POST | `/api/verify/snippet` | Check a snippet with lean-interact. Body: `{"code": str}` |
| GET | `/{path}` | Only when `STATIC_DIR` holds a frontend build (the hosted image). Serves the built site: real files as they are, any other non-`/api` path gets `index.html` |

Server-sent event streams (`/api/chat`) send an SSE comment (`: ping`) after 15 s without
an event. A first Mathlib load or a long Lean check can go quiet, and this stops proxies
from dropping the connection. Clients that only read `data:` lines ignore it.

`POST /api/session` checks the `ezlogic_guest` cookie and reuses the guest ID if
the JWT is valid. If the cookie is missing or invalid, FastAPI sets a new
`HttpOnly` cookie with a signed JWT that lasts 24 hours. `POST /api/chat` also
checks the guest cookie and can start a session on its own. Browser clients
calling the API from a different port on the same hostname should use
`credentials: "include"` with `fetch`.

For HTTPS deployments, set `GUEST_COOKIE_SECURE=true` and set `GUEST_JWT_SECRET`
to a persistent random secret shared by all backend workers. Without a configured
secret, local sessions expire when the backend process restarts.

## Hosting

The hosted demo (Google Cloud Run, see [`../deploy/README.md`](../deploy/README.md)) runs this
backend from the root `Dockerfile`.

- **Serving the site.** `STATIC_DIR` (default `backend/static/`, git-ignored) holds the frontend
  build. When it contains an `index.html`, `main.py` serves the site at the same origin as `/api`.
  Locally there is no build there, and the Vite dev server serves the frontend as usual.
- **Startup limit.** A fresh Cloud Run instance reads Mathlib from the image for the first time,
  which takes about 3 minutes. The deploy therefore sets `LEAN_STARTUP_TIMEOUT=900`; the default
  of 180 s is only enough locally.
- **Endpoint exposure.** On a public deployment, `/api/files` and `/api/verify/*` are reachable by
  anyone with the URL, as they are locally.

## Proof dependency graphs

`GET /api/queries/{query_id}/graph` returns `{query_id, root_node_id, nodes}` for
the current guest's saved graph, or `null` if the guest owns the proof and its
graph is missing. Unknown queries and queries outside the current guest session
return the same 404. This endpoint only reads PostgreSQL.
`POST /api/queries/{query_id}/graph` asks Lean to build a missing graph or upgrade
one from the older format. It uses the same guest's saved proof and preserves
the original response. It returns a graph immediately when it already includes
the theorem and lemma metadata.

On a newly completed writer run, the backend takes the exact final source string,
rechecks it in Lean, and runs `agent/graph_extract.lean` in the resulting REPL
environment. The extractor uses `Lean.ConstantInfo.getUsedConstantsAsSet` for
technical declaration references. The proof view uses `proof_dependency_ids`,
which Lean obtains from the proof body and restricts to named theorem or lemma
declarations. Generated helpers and references from the statement are visible
in the technical view. The source snapshot, query, nodes, and root are saved
together in one transaction. Graph extraction failures leave the original response
and verification status intact, with no graph attached.

The writer is instructed to name the final theorem `ezlogic_main` (namespaces are
allowed). A source with exactly one other named theorem also works. Multiple
candidate theorems without one unambiguous `ezlogic_main`, anonymous examples,
Lean errors, `sorry`, and root dependencies on axioms outside `propext`,
`Classical.choice`, and `Quot.sound` do not produce a graph.

Extraction expands the root and its immediate dependencies, with a maximum of
512 nodes. Boundary nodes have `depends_on_ids: null`; expanded nodes with no
references have `[]`. All emitted edges have endpoints in the response. References
can include definitions, types, constructors, and self/cyclic references, not just
human-readable lemmas. Old queries are not automatically backfilled.

`schema.sql` adds `queries.root_node_id` and the `proof_nodes` table idempotently
on backend startup. Node IDs are fully qualified Lean names, unique within each
query; PostgreSQL stores their dependency lists as `text[]`. Array references are
validated in the application before committing. Local PostgreSQL works directly;
Docker is not required.

Tests (from `backend/`):

```powershell
.\.venv\Scripts\python.exe -m pytest -q
$env:RUN_GRAPH_DB_TESTS = '1'
.\.venv\Scripts\python.exe -m pytest tests/test_graph_db.py -q
$env:RUN_LEAN_GRAPH_TESTS = '1'
$env:LEAN_GRAPH_REPL_DIR = '<path to the built REPL project directory>'
.\.venv\Scripts\python.exe -m pytest tests/test_graph_lean_integration.py -q
```

The database test uses the configured database, creates unique disposable test
records, and removes them afterwards. The real Lean tests use small core-Lean
proofs and do not call an LLM or load Mathlib. Full Mathlib verification still
depends on sufficient available memory for the backend's configured REPL.

## Project files

- `main.py` - FastAPI app and routes (plus SSE keep-alives, and serving the built frontend when hosted)
- `config.py` - Configuration from environment / `.env`
- `agent/agent.py` - Anthropic tool-calling loop and system prompt
- `agent/tools.py` - Tool schemas and dispatcher
- `agent/workspace.py` - Sandboxed file operations (paths cannot escape `WORKSPACE_DIR`)
- `agent/lean.py` - lean-interact REPL file and snippet checks
- `workspace/` - The agent's local file system (git-ignored). Add a `lakefile` here to make it
  a Lake project (e.g. with Mathlib); files are then checked with `lake env lean`.
