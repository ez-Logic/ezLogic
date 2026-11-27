# ezLogic: notes for Claude

LLM agents write Lean 4 proofs and check them against Mathlib. They then explain the proof as step
cards linked to Lean line ranges. Frontend: SvelteKit (`frontend/`). Backend: FastAPI + agents +
lean-interact REPL (`backend/`). Storage: Postgres. See `README.md` and `backend/README.md`.

## Running and testing locally
- **Node 22.17+.** `frontend/.npmrc` sets `engine-strict`, and the default `node` on dev machines
  may be 20, so use `nvm use` in `frontend/` (reads `.nvmrc`) before any `npm` command. Then:
  - `npm run dev` (Vite, port 5173; proxies `/api` to `API_PROXY_TARGET`, default `:8000`)
  - `npm test` (vitest)
  - `npm run check` (svelte-check)
  - `npm run build` (adapter-static output in `frontend/build/`)
  - `npm run desktop:dev` / `desktop:build` (Tauri 2 desktop app in `frontend/src-tauri/`; needs
    Rust). On desktop, `api.ts` routes requests through `@tauri-apps/plugin-http`. The server URL
    comes from the in-app Server setting, then `VITE_API_URL`, then `http://localhost:8000`.
    See `frontend/README.md`.
- **Backend dependencies live only in `backend/.venv`.** Run things as:
  - `cd backend && .venv/bin/python main.py` (port 8000, auto-reload)
  - `.venv/bin/python -m pytest tests` (plain `pytest` can't import `agent`)
  - The real-Lean graph test is skipped unless `RUN_LEAN_GRAPH_TESTS=1` (it needs the built REPL
    and Mathlib).
- Port 8000 may already have a developer's own backend on it. Check with `lsof -iTCP:8000`, and use
  another port (and `API_PROXY_TARGET`) rather than stopping someone else's process.
- Real chat requests call the Anthropic API with the key in `backend/.env` and cost money. Mock mode
  (`VITE_MOCK=1`) needs no backend.

## Hosted demo: Google Cloud Run (`deploy/`)
One service in `australia-southeast1` serves the built site and `/api` from one origin:
- the root `Dockerfile` bundles Lean 4.35.0, Mathlib v4.35.0, a prebuilt REPL, the backend and
  the frontend build;
- `main.py` serves the site from `STATIC_DIR`;
- Postgres is Cloud SQL `ezlogic-db`.

Everything goes through `deploy/cloudrun.sh`; details are in `deploy/README.md`.
`.github/workflows/deploy.yml` runs the same script from GitHub, only when started by hand, and
`ci.yml` runs the backend and frontend tests on every push to any branch.

### Rules for changing the live demo
- **Never deploy straight to visitors.** Use `build` → `candidate` (no traffic, at
  `https://candidate---…run.app`) → test → `promote`. `deploy` sends 100% at once; keep it for
  emergencies the user asks for.
- **To undo:** `deploy/cloudrun.sh rollback` (to the baseline in `deploy/baseline.env`) or
  `rollback <revision>`.
  - The traffic switch takes seconds.
  - The target revision usually starts cold, so proofs wait **3–10 min** while Mathlib loads; the
    page itself works immediately.
  - Tell the user about this wait.
- **Traffic stays pinned to a named revision.** Don't use `--to-latest`. Change traffic only through
  `deploy`, `promote`, `rollback`, `pause` and `resume`, which keep it pinned.
- **Don't add lasting traffic tags.** A tagged revision keeps its warm instance running, and billed,
  even with 0% traffic. Only the short-lived `candidate` tag is used; `promote` and `rollback`
  remove it. That's why the baseline is a file, not a `baseline` tag.
- **The current baseline is `demo-baseline-2`** (Anthropic API):
  - revision `ezlogic-00010-tic`;
  - image tag `ezlogic:demo-baseline-2` (`sha256:6746806d…`);
  - git tag on `5d21d51`;
  - Cloud SQL backup `demo-baseline-2`.

  The earlier `demo-baseline-1` (revision `ezlogic-00002-6tq`, OpenRouter) can be reached with
  `rollback ezlogic-00002-6tq`.

  To move it once a new version has proven itself: `deploy/cloudrun.sh mark-baseline <name>`, then
  commit `deploy/baseline.env` and `git push origin <name>`.
- **Database:** `db.init_db()` only adds missing tables. Run `deploy/cloudrun.sh backup <name>`
  before changing `backend/schema.sql` in a way old code couldn't read.
- **Know what it costs.** One warm 2 vCPU / 8 GiB instance runs at about $5–6 a day from the free
  trial credit. A candidate adds a second instance while it's up. `pause` / `resume` around the
  pitch. Deploys and builds (~25 min, Cloud Build) are actions on the user's account, so confirm
  before running them.
- **The Anthropic API key** (`ANTHROPIC_API_KEY`) is stored as an environment variable on the
  service, visible to project members. The script reads it from `backend/.env`. Never print it or
  commit it.
  - Only the key is copied. The base URL and model come from the backend's defaults
    (`api.anthropic.com/v1/`, `claude-haiku-5-5`).
  - `demo-baseline-1` (revision `ezlogic-00002-6tq`) predates the switch and still runs on
    OpenRouter.

## Repo conventions
- Don't commit `.vscode/`, the stray `https:/` directory, `backend/.env`, or `backend/static/`.
- `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile` and `render.yaml` belong to
  teammates and are not used by the Cloud Run deployment. Leave them alone unless asked.
