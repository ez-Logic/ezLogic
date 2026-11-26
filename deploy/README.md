# Hosting the demo on Google Cloud Run

One Cloud Run service in Sydney (`australia-southeast1`) runs the whole app:

```
https://ezlogic-<project number>.australia-southeast1.run.app
   ├─ /api/*  FastAPI backend (agents, Lean, history)
   └─ /*      the built frontend, served by the same backend
Postgres: Cloud SQL (smallest Postgres 16 instance)
```

The site and the API share one address, so the guest-session cookie is first-party.
Browsers that block cross-site cookies (Safari on iPhones) work, and no CORS or proxy is
needed.

The image (root `Dockerfile`) contains:
- Lean 4.35.0;
- Mathlib v4.35.0, the versions tested locally;
- the lean-interact REPL, already built;
- the frontend build.

A new instance only has to load Mathlib into memory. The first time, Cloud Run reads the
files from the image, which takes about 3 minutes; after that a load takes about 78 s.

Measured on the first deployment:
- the image build took 23 minutes;
- the first Mathlib load took 180 s;
- a Lean check takes 0.3 s once Mathlib is loaded;
- a full proof (writer, explainer, dependency graph, saved to Cloud SQL) took 22 s.

## Cost
These are estimates; check [Cloud Run pricing](https://cloud.google.com/run/pricing).

| Part | Size | About |
| --- | --- | --- |
| Cloud Run, kept warm | 2 vCPU, 8 GiB, 1 instance | $4.5–6 a day while running |
| Cloud SQL | db-f1-micro, 10 GB | ~$0.30 a day |
| Image storage | ~10 GB in Artifact Registry | ~$1 a month |
| LLM (Anthropic API, Claude Haiku 5.5) | ~1¢ per proof | a few dollars |

A new Google Cloud account's $300 trial credit (90 days) covers the Google part. After the
pitch, run `deploy/cloudrun.sh pause`, or delete everything (see [Clean up](#clean-up)).

## One-time setup (your accounts)
1. **Create a Google Cloud account and project** at <https://console.cloud.google.com>, and start the
   free trial. It needs a card, but the card isn't charged during the trial.
2. **Install the gcloud CLI and log in:**
   ```bash
   brew install --cask google-cloud-sdk
   gcloud auth login
   gcloud config set project <PROJECT_ID>
   ```
3. **The Anthropic API key:** the script takes `ANTHROPIC_API_KEY` from the environment, else from
   `backend/.env`, else asks for it.
   - **Where it ends up:** an environment variable of the Cloud Run service. The image never
     contains `backend/.env`. Anyone with access to the project can see it.
   - **What else is copied:** only the key. The service uses the backend's default endpoint
     (`https://api.anthropic.com/v1/`) and `ANTHROPIC_MODEL` (default `claude-haiku-5-5`; override
     when running the script). It does not use any `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` from
     your local `.env`.

## Deploy
```bash
deploy/cloudrun.sh all        # = setup + build + deploy
```
- **`setup`** turns on the APIs and creates the image registry and the Cloud SQL instance (about 10
  minutes the first time). It also grants the default service account what builds and the service
  need.
- **`build`** builds the image on Cloud Build: 20–40 minutes the first time, mostly downloading
  Mathlib. Your Mac uploads only the source, a few MB, not Mathlib (see `.gcloudignore`).
- **`deploy`** creates or updates the service:
  - one warm instance, never more, since each instance loads its own Mathlib;
  - CPU always on, so the Mathlib warm-up runs before the first visitor;
  - a 60-minute request limit for long proofs.

  On the first deploy it also creates the database user and the session secret. Later deploys keep
  both.

  Settings on the service:
  - `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. New revisions drop the old `OPENROUTER_*` settings;
    `demo-baseline-1` (revision `ezlogic-00002-6tq`) predates the switch and still uses OpenRouter;
  - `DATABASE_URL`, over the Cloud SQL socket;
  - `GUEST_JWT_SECRET` and `GUEST_COOKIE_SECURE=true`;
  - `FRONTEND_URL`;
  - `LEAN_STARTUP_TIMEOUT=900`, since the default of 180 s is too short for the first Mathlib load.

  Anyone with access to the project can read these in the console.

After changing the code, follow [Iterating and rolling back](#iterating-and-rolling-back) below.
`deploy/cloudrun.sh build && deploy/cloudrun.sh deploy` also works, but it sends every visitor to the
new version at once.

## Iterating and rolling back
The working demo is frozen as **`demo-baseline-2`** (Anthropic API). `deploy/baseline.env` records
it, and `rollback` returns to it.

| Layer | Baseline | How to get it back |
| --- | --- | --- |
| Live service | Cloud Run revision `ezlogic-00010-tic` (image + settings + environment variables) | `deploy/cloudrun.sh rollback` (traffic in seconds; proofs 3–10 min later if cold) |
| Image | Artifact Registry tag `ezlogic:demo-baseline-2` (`sha256:6746806d…`) | `IMAGE_TAG=demo-baseline-2 deploy/cloudrun.sh candidate` |
| Code | git tag `demo-baseline-2` (`5d21d51`: `main` after PR #17, plus the Anthropic deploy settings) | `git checkout demo-baseline-2` |
| Database | Cloud SQL backup `demo-baseline-2`, plus daily automatic backups (7 kept) | `gcloud sql backups list --instance ezlogic-db`, then `gcloud sql backups restore <id> --restore-instance ezlogic-db` |

**Earlier baseline:** `demo-baseline-1` is the first working demo, before the switch to the
Anthropic API: revision `ezlogic-00002-6tq`, OpenRouter, code `b7ed391`. It has the same git tag,
image tag and Cloud SQL backup names. Return to it with
`deploy/cloudrun.sh rollback ezlogic-00002-6tq`; it still has its own OpenRouter key.

Every new version goes through a test URL before visitors see it:
```bash
git checkout -b my-change            # ...edit, commit...
deploy/cloudrun.sh build             # image tagged with the commit (and `latest`), ~25 min
deploy/cloudrun.sh candidate         # new revision with NO traffic, at https://candidate---ezlogic-…run.app
                                     # wait for Mathlib (3–10 min), then try it at that URL
deploy/cloudrun.sh promote           # all visitors move to it…
deploy/cloudrun.sh rollback          # …or back to the baseline (or: rollback <revision>)
deploy/cloudrun.sh revisions         # what serves traffic, the candidate, the baseline, which image each runs
```

How it works:
- **Traffic is pinned.** It always goes to a named revision, so nothing moves unless `deploy`,
  `promote`, `rollback`, `pause` or `resume` moves it.
- **The traffic switch takes seconds** and needs no rebuild. But a revision with no traffic loses its
  instance within minutes, so the revision you roll back to usually starts cold. **Proofs then wait
  3–10 minutes** while Mathlib loads; the page and login work straight away.
  - Measured: the first load took 3 min on one fresh instance, 8½ min on another, and 6½ min on
    the baseline after a `promote` → `rollback` test.
  - On pitch day, avoid needing a rollback: try candidates well before, and leave the version that
    works alone.
- **Only the short-lived `candidate` tag is used.** A revision with a traffic tag keeps its warm
  instance running, and billed, even with no traffic. That's why there is no permanent `baseline`
  tag, and why `promote` and `rollback` remove `candidate`. While a candidate is up, two instances
  run, at roughly $0.20–0.25 an hour extra.
- **New baseline.** When a new version has proven itself, run
  `deploy/cloudrun.sh mark-baseline demo-baseline-2`. It tags the serving revision's image, backs
  up the database, tags the git commit and rewrites `deploy/baseline.env`. Then commit and run
  `git push origin demo-baseline-2`.
- **Database.** `db.init_db()` only adds missing tables, so old and new code share one database.
  Before a change to `backend/schema.sql` that the old code couldn't read, run
  `deploy/cloudrun.sh backup <name>`. Rolling such a change back then also means restoring that
  backup.

## GitHub Actions
Two workflows live in `.github/workflows/`:

- **`ci.yml` (automatic)** runs on every pull request and every push to `main`:
  - backend: `pytest`, including the database tests against a throwaway Postgres 16. The
    real-Lean tests stay skipped, since they need Mathlib;
  - frontend: `npm run check`, `npm test` and `npm run build`.

  It needs no secrets.
- **`deploy.yml` (manual)** runs this script from the Actions tab: **Deploy to Cloud Run → Run
  workflow** on `main`, then pick an action. Code is tested by CI in its pull request, merged, and
  then tried as a candidate before visitors see it.

  | Action | What it does |
  | --- | --- |
  | `candidate` | Runs CI, then `build` (~25 min), `candidate` with that commit's image, and `smoke` (checks `/health` and the page answer). Ends with the candidate URL. |
  | `promote` | Sends all traffic to the candidate. |
  | `rollback` | All traffic back to the baseline in `deploy/baseline.env`, or to the revision you type. |
  | `revisions`, `pause`, `resume` | As on the command line. |

  It never runs `deploy` (all traffic at once), and nothing deploys on its own. Between
  `candidate` and `promote`, try a proof at the candidate URL yourself: `smoke` doesn't wait for
  Mathlib. `mark-baseline` stays on the command line, since it commits and pushes a git tag.

**One-time setup** (someone with Owner on the Google Cloud project):
1. Run `deploy/cloudrun.sh github-setup`. It creates:
   - a `github-deploy` service account that can build, deploy revisions and move traffic;
   - a Workload Identity pool that lets GitHub sign in as that account without a stored key, only
     from jobs in this repository's `cloud-run` environment.

   It prints the values for step 2.
2. In GitHub, go to **Settings → Environments → New environment** and name it `cloud-run`.
   - **Variables:** add `GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER` and
     `GCP_SERVICE_ACCOUNT`, using the values step 1 printed.
   - **Secret:** add `ANTHROPIC_API_KEY`. Every candidate copies it to the service, as the script
     does locally.
   - **Deployment branches and tags:** allow only `main`.
   - **Optional:** add required reviewers, so every deploy waits for an approval.
3. Optional: in **Settings → Branches**, protect `main` and require the **Backend tests** and
   **Frontend checks** checks to pass before merging.

## Pitch day
1. `deploy/cloudrun.sh resume`, if you paused it, at least 10 minutes before you start. A new
   instance needs a few minutes to load Mathlib the first time.
2. Open the URL (`deploy/cloudrun.sh url`) and run one example proof. This confirms Mathlib is
   loaded and the AI key works.
3. If something looks wrong, read the logs:
   ```bash
   gcloud run services logs read ezlogic --region australia-southeast1 --limit 100
   ```
   - **"Mathlib loaded in …"** means it is ready.
   - **An out-of-memory restart** means the instance needs more memory: redeploy with `--memory 16Gi`
     in `cloudrun.sh`.

## Clean up
```bash
deploy/cloudrun.sh pause                                         # stop paying for the warm instance
gcloud run services delete ezlogic --region australia-southeast1   # remove the service
gcloud sql instances delete ezlogic-db                             # remove the database (and chat history)
```
