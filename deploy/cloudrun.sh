#!/usr/bin/env bash
# Deploy the ezLogic demo to Google Cloud Run. See deploy/README.md.
#
#   deploy/cloudrun.sh setup      # once: APIs, image registry, Postgres (Cloud SQL), permissions
#   deploy/cloudrun.sh build      # build the image on Cloud Build, tagged with the git commit
#   deploy/cloudrun.sh deploy     # create/update the service and send it ALL traffic (quick fixes)
#   deploy/cloudrun.sh all        # setup + build + deploy
#   deploy/cloudrun.sh url        # print the site's URL
#   deploy/cloudrun.sh pause      # after the pitch: no instance kept running (stops most billing)
#   deploy/cloudrun.sh resume     # before the pitch: keep one warm instance again
#
# Iterating safely (deploy/README.md, "Iterating and rolling back"):
#   deploy/cloudrun.sh candidate          # deploy the last build with NO traffic, at a test URL
#   deploy/cloudrun.sh smoke              # check the candidate answers (/health and the site)
#   deploy/cloudrun.sh promote            # send all traffic to the tested candidate
#   deploy/cloudrun.sh rollback [REV]     # send all traffic back to the baseline (deploy/baseline.env)
#   deploy/cloudrun.sh revisions          # list revisions: traffic, tags, image
#   deploy/cloudrun.sh mark-baseline NAME # make the serving revision the new baseline
#   deploy/cloudrun.sh backup NAME        # on-demand Cloud SQL backup
#
# GitHub Actions (.github/workflows/deploy.yml runs this script; deploy/README.md):
#   deploy/cloudrun.sh github-setup       # once: let the repo's `cloud-run` environment deploy
#
# Every step is safe to re-run. Settings (override with environment variables):
#   PROJECT_ID  (default: gcloud's current project)   REGION   (australia-southeast1)
#   SERVICE     (ezlogic)                              ANTHROPIC_MODEL (claude-haiku-5-5)
#   IMAGE_TAG   (latest; or a commit tag from `build`, or a baseline name)
#   ANTHROPIC_API_KEY: taken from the environment, else backend/.env, else asked for. Only the
#   key is copied to Cloud Run; the base URL is the backend's default (api.anthropic.com).
#   GITHUB_REPO (ez-Logic/ezLogic): the repository `github-setup` trusts.
set -euo pipefail
# Never stop to ask (e.g. "enable this API?"): the script enables what it needs itself.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-australia-southeast1}"
SERVICE="${SERVICE:-ezlogic}"
REPO="${REPO:-ezlogic}"
SQL_INSTANCE="${SQL_INSTANCE:-ezlogic-db}"
DB_NAME="${DB_NAME:-ezlogic}"
DB_USER="${DB_USER:-ezlogic}"
ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-haiku-5-5}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
GITHUB_REPO="${GITHUB_REPO:-ez-Logic/ezLogic}"
BASELINE_FILE=deploy/baseline.env

if [[ -z "$PROJECT_ID" ]]; then
  echo "No Google Cloud project. Run: gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"
IMAGE="${IMAGE_BASE}:${IMAGE_TAG}"
SQL_CONN="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
SITE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Newly enabled APIs can take a few minutes to start answering: retry until they do.
retry() {
  local tries=0
  until "$@"; do
    tries=$((tries + 1))
    if (( tries >= 20 )); then
      echo "Still failing after $tries tries: $*" >&2
      return 1
    fi
    echo "  (not ready yet; retrying in 15 s)" >&2
    sleep 15
  done
}

service_exists() {
  gcloud run services describe "$SERVICE" --region "$REGION" --format='value(metadata.name)' >/dev/null 2>&1
}

# The LLM key for the service. Cloud Run never sees backend/.env (.dockerignore keeps
# it out of the image), so the key is copied into the service's environment variables.
anthropic_key() {
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    printf '%s' "$ANTHROPIC_API_KEY"
  elif [[ -f backend/.env ]] && grep -q '^ANTHROPIC_API_KEY=.' backend/.env; then
    grep '^ANTHROPIC_API_KEY=' backend/.env | head -1 | cut -d= -f2- | tr -d '"'"'"
  else
    local key
    read -rsp "Anthropic API key: " key </dev/tty
    echo >&2
    printf '%s' "$key"
  fi
}

setup() {
  say "Project ${PROJECT_ID} (${PROJECT_NUMBER}), region ${REGION}"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com sqladmin.googleapis.com --project "$PROJECT_ID"

  say "Image registry ${REPO}"
  ensure_repo() {
    gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
      gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"
  }
  retry ensure_repo

  say "Permissions for the default service account (builds and the running service)"
  for role in roles/cloudsql.client roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${RUNTIME_SA}" \
      --role "$role" --condition None --quiet >/dev/null
  done

  say "Postgres: Cloud SQL instance ${SQL_INSTANCE} (smallest tier; creating takes ~10 min)"
  ensure_sql() {
    gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1 ||
      gcloud sql instances create "$SQL_INSTANCE" --database-version POSTGRES_16 \
        --edition enterprise --tier db-f1-micro --region "$REGION" --storage-size 10 \
        --backup-start-time 16:00
  }
  retry ensure_sql
  if ! gcloud sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" >/dev/null 2>&1; then
    gcloud sql databases create "$DB_NAME" --instance "$SQL_INSTANCE"
  fi
}

# The commit an image is built from: short sha, plus "-dirty" if tracked files changed.
commit_tag() {
  local sha
  sha="$(git rev-parse --short HEAD)"
  if git diff --quiet HEAD -- .; then printf '%s' "$sha"; else printf '%s-dirty' "$sha"; fi
}

build() {
  local tag
  tag="$(commit_tag)"
  say "Building ${IMAGE_BASE}:${tag} on Cloud Build (Mathlib makes this ~10 GB; ~25 min)"
  gcloud builds submit . --tag "${IMAGE_BASE}:${tag}" \
    --timeout 3600s --machine-type e2-highcpu-8 --disk-size 100
  # `latest` follows the newest build. Every build keeps its own commit tag and each
  # baseline keeps its name (mark-baseline), so earlier images stay deployable.
  gcloud artifacts docker tags add "${IMAGE_BASE}:${tag}" "${IMAGE_BASE}:latest" --quiet
  echo "Built ${tag}. Deploy it with: deploy/cloudrun.sh candidate (or IMAGE_TAG=${tag} ...)"
}

# Settings shared by every revision this script creates.
run_flags() {
  RUN_FLAGS=(
    --image "$IMAGE" --region "$REGION"
    --execution-environment gen2 --cpu 2 --memory 8Gi --cpu-boost
    --no-cpu-throttling --min-instances 1 --max-instances 1
    --concurrency 80 --timeout 3600 --allow-unauthenticated
    --add-cloudsql-instances "$SQL_CONN"
    # Which image a revision runs, shown by `revisions` (label values: [a-z0-9_-]).
    --update-labels "image=$(printf '%s' "$IMAGE_TAG" | tr -c 'a-z0-9_-' '-')"
  )
  # A new instance reads Mathlib from the image for the first time, which takes a few
  # minutes on Cloud Run (78 s once read); the default 180 s limit is too short.
  RUN_ENV="ANTHROPIC_MODEL=${ANTHROPIC_MODEL},FRONTEND_URL=${SITE_URL},GUEST_COOKIE_SECURE=true"
  RUN_ENV+=",LEAN_STARTUP_TIMEOUT=900"
  RUN_ENV+=",ANTHROPIC_API_KEY=$(anthropic_key)"
  # Settings earlier revisions had and new ones must not keep (the OpenRouter era).
  # Older revisions keep their own copies, so rolling back to them still works.
  RUN_REMOVE="OPENROUTER_API_KEY,OPENROUTER_MODEL"
}

# Traffic is always pinned to a named revision (never "latest revision"), so nothing
# moves unless one of these commands moves it.
serve_revision() {
  gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "$1=100" --quiet
}

latest_revision() {
  gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.latestCreatedRevisionName)'
}

traffic_json() {
  gcloud run services describe "$SERVICE" --region "$REGION" --format=json
}

# The revision carrying a traffic tag, or nothing.
tagged_revision() {
  traffic_json | jq -r --arg tag "$1" '[.status.traffic[]? | select(.tag == $tag)][0].revisionName // empty'
}

# A revision with a traffic tag keeps its minimum instance running (and billed) even
# with no traffic, so the only tag used is the short-lived `candidate`.
drop_candidate_tag() {
  if [[ -n "$(tagged_revision candidate)" ]]; then
    gcloud run services update-traffic "$SERVICE" --region "$REGION" --remove-tags candidate --quiet
  fi
}

deploy() {
  run_flags
  if service_exists; then
    say "Updating ${SERVICE} with ${IMAGE} and sending it all traffic (database password and session secret are kept)"
    gcloud run deploy "$SERVICE" "${RUN_FLAGS[@]}" --update-env-vars "$RUN_ENV" \
      --remove-env-vars "$RUN_REMOVE" --quiet
    serve_revision "$(latest_revision)"
  else
    say "Creating ${SERVICE}"
    # A fresh database password (the user is created or reset to match) and a
    # session secret that stays the same across later deploys.
    local db_password session_secret env="$RUN_ENV"
    db_password="$(openssl rand -hex 24)"
    session_secret="$(openssl rand -hex 32)"
    if gcloud sql users list --instance "$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
      gcloud sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$db_password"
    else
      gcloud sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$db_password"
    fi
    env+=",DATABASE_URL=postgresql://${DB_USER}:${db_password}@/${DB_NAME}?host=/cloudsql/${SQL_CONN}"
    env+=",GUEST_JWT_SECRET=${session_secret}"
    gcloud run deploy "$SERVICE" "${RUN_FLAGS[@]}" --set-env-vars "$env" --quiet
  fi
  url
}

url() {
  gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
}

candidate() {
  service_exists || { echo "No service yet: run deploy/cloudrun.sh deploy first." >&2; exit 1; }
  run_flags
  say "Deploying ${IMAGE} as a candidate with no traffic"
  gcloud run deploy "$SERVICE" "${RUN_FLAGS[@]}" --update-env-vars "$RUN_ENV" \
    --remove-env-vars "$RUN_REMOVE" --no-traffic --tag candidate --quiet
  traffic_json | jq -r '.status.traffic[]? | select(.tag == "candidate") | "Candidate: \(.revisionName) at \(.url)"'
  echo "It loads Mathlib first (3-10 min). Test it, then: deploy/cloudrun.sh promote (or rollback)."
}

# A quick check that the candidate answers: the API's /health and the site's page. It doesn't
# wait for Mathlib, so try a proof at the candidate URL yourself before promoting.
smoke() {
  local url
  url="$(traffic_json | jq -r '[.status.traffic[]? | select(.tag == "candidate")][0].url // empty')"
  [[ -n "$url" ]] || { echo "No candidate revision (deploy/cloudrun.sh candidate)." >&2; exit 1; }
  say "Smoke test: ${url}"
  retry curl -fsS --max-time 20 -o /dev/null "${url}/health"
  if ! curl -fsS --max-time 20 "${url}/" | grep -qi '<html'; then
    echo "The candidate's site did not return a page." >&2
    exit 1
  fi
  echo "The candidate answers at ${url}. Try a proof there (the first waits for Mathlib), then promote."
}

promote() {
  local rev
  rev="$(tagged_revision candidate)"
  [[ -n "$rev" ]] || { echo "No candidate revision (deploy/cloudrun.sh candidate)." >&2; exit 1; }
  say "Sending all traffic to the candidate ${rev}"
  serve_revision "$rev"
  drop_candidate_tag
}

rollback() {
  local rev="${1:-}"
  if [[ -z "$rev" ]]; then
    # shellcheck disable=SC1090
    source "$BASELINE_FILE"
    rev="$BASELINE_REVISION"
  fi
  say "Rolling back: all traffic to ${rev}"
  serve_revision "$rev"
  drop_candidate_tag
  echo "If ${rev} had no instance running, proofs wait 3-10 min while it loads Mathlib (the site itself works now)."
}

revisions() {
  traffic_json | jq -r '.status.traffic[]?
    | "traffic \(.percent // 0)% -> \(.revisionName)\(if .tag then "  [" + .tag + ": " + .url + "]" else "" end)"'
  if [[ -f "$BASELINE_FILE" ]]; then
    sed -n 's/^BASELINE_REVISION=/baseline  -> /p' "$BASELINE_FILE"
  fi
  gcloud run revisions list --service "$SERVICE" --region "$REGION" \
    --format='table(metadata.name,metadata.labels.image,metadata.creationTimestamp.date("%Y-%m-%d %H:%M"))'
}

backup() {
  local name="${1:?usage: deploy/cloudrun.sh backup NAME}"
  gcloud sql backups create --instance "$SQL_INSTANCE" --description "$name"
}

# Freeze what is serving now as the new baseline: tag its image, back up the
# database, tag the git commit, and record it in deploy/baseline.env.
mark_baseline() {
  local name="${1:?usage: deploy/cloudrun.sh mark-baseline NAME}"
  local rev digest
  rev="$(traffic_json | jq -r '[.status.traffic[]? | select((.percent // 0) == 100)][0].revisionName // empty')"
  [[ -n "$rev" ]] || { echo "No revision is serving 100% of traffic." >&2; exit 1; }
  digest="$(gcloud run revisions describe "$rev" --region "$REGION" --format='value(status.imageDigest)')"
  say "Baseline ${name}: revision ${rev}, image ${digest##*@}"
  gcloud artifacts docker tags add "$digest" "${IMAGE_BASE}:${name}" --quiet
  backup "$name"
  git tag -a "$name" -m "Cloud Run demo baseline (revision ${rev}, image ${digest##*@})"
  {
    echo "# The known-good demo: what \`deploy/cloudrun.sh rollback\` returns to."
    echo "# Written by \`deploy/cloudrun.sh mark-baseline <name>\`; commit it (and push the git tag)."
    echo "# See deploy/README.md, \"Iterating and rolling back\"."
    echo "BASELINE_NAME=${name}"
    echo "BASELINE_REVISION=${rev}"
    echo "BASELINE_IMAGE_TAG=${name}"
    echo "BASELINE_GIT_TAG=${name}"
    echo "BASELINE_SQL_BACKUP=${name}"
  } > "$BASELINE_FILE"
  echo "Recorded in ${BASELINE_FILE}. Commit it, then: git push origin ${name}"
}

# Let .github/workflows/deploy.yml run this script without a stored Google key. GitHub's
# sign-in token for a job is exchanged for a short-lived token of a deploy service account
# (Workload Identity Federation). Only jobs in GITHUB_REPO's `cloud-run` environment can
# use it, so pull requests and other workflows can't deploy.
github_setup() {
  local sa_name=github-deploy pool_id=github provider_id=ezlogic
  local sa="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"
  local pool="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${pool_id}"
  say "GitHub Actions deploys from ${GITHUB_REPO} (environment cloud-run)"
  gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"

  say "Deploy service account ${sa}"
  gcloud iam service-accounts describe "$sa" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa_name" --display-name "GitHub Actions deploys"
  # Build on Cloud Build (streaming its logs needs viewer), tag images, create revisions and
  # move traffic. A new service account can take a few seconds to be usable, hence retry.
  for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.writer \
      roles/storage.admin roles/viewer roles/serviceusage.serviceUsageConsumer; do
    retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${sa}" \
      --role "$role" --condition None --quiet >/dev/null
  done
  # Builds and revisions run as the default compute service account.
  gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member "serviceAccount:${sa}" \
    --role roles/iam.serviceAccountUser --quiet >/dev/null

  say "Workload identity pool ${pool_id}, provider ${provider_id}"
  gcloud iam workload-identity-pools describe "$pool_id" --location global >/dev/null 2>&1 ||
    gcloud iam workload-identity-pools create "$pool_id" --location global \
      --display-name "GitHub Actions"
  gcloud iam workload-identity-pools providers describe "$provider_id" --location global \
      --workload-identity-pool "$pool_id" >/dev/null 2>&1 ||
    gcloud iam workload-identity-pools providers create-oidc "$provider_id" --location global \
      --workload-identity-pool "$pool_id" --display-name "GitHub ${GITHUB_REPO}" \
      --issuer-uri https://token.actions.githubusercontent.com \
      --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
      --attribute-condition "assertion.repository == '${GITHUB_REPO}'"
  gcloud iam service-accounts add-iam-policy-binding "$sa" --role roles/iam.workloadIdentityUser \
    --member "principal://iam.googleapis.com/${pool}/subject/repo:${GITHUB_REPO}:environment:cloud-run" \
    --quiet >/dev/null

  cat <<EOF

Done. In GitHub: Settings > Environments > New environment "cloud-run". Then add:
  Variables  GCP_PROJECT_ID                  ${PROJECT_ID}
             GCP_WORKLOAD_IDENTITY_PROVIDER  ${pool}/providers/${provider_id}
             GCP_SERVICE_ACCOUNT             ${sa}
  Secret     ANTHROPIC_API_KEY               (the key in backend/.env)
Under "Deployment branches and tags", allow only main. Permissions can take a few minutes to apply.
EOF
}

case "${1:-}" in
  setup) setup ;;
  build) build ;;
  deploy) deploy ;;
  all) setup; build; deploy ;;
  url) url ;;
  # pause/resume create a new revision (same image, new scaling) and move traffic to it.
  pause)
    gcloud run services update "$SERVICE" --region "$REGION" --min-instances 0 --cpu-throttling --quiet
    serve_revision "$(latest_revision)" ;;
  resume)
    gcloud run services update "$SERVICE" --region "$REGION" --min-instances 1 --no-cpu-throttling --quiet
    serve_revision "$(latest_revision)" ;;
  candidate) candidate ;;
  smoke) smoke ;;
  promote) promote ;;
  rollback) rollback "${2:-}" ;;
  revisions) revisions ;;
  mark-baseline) mark_baseline "${2:-}" ;;
  backup) backup "${2:-}" ;;
  github-setup) github_setup ;;
  *) sed -n '2,30p' "$0"; exit 1 ;;
esac
