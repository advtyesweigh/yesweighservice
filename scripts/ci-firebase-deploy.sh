#!/usr/bin/env bash
# Retry firebase deploy for transient Google API errors (e.g. firebaserules 503).
set -u

TARGETS="${1:?Usage: ci-firebase-deploy.sh <targets> [project]}"
PROJECT="${2:-yesweigh-service}"
MAX_ATTEMPTS="${FIREBASE_DEPLOY_RETRIES:-5}"
# Short first backoff helps clear firebaserules HTTP 409 races quickly.
DELAY="${FIREBASE_DEPLOY_RETRY_DELAY_SEC:-10}"
REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
HTTP_AGENT_FIX="${REPO_ROOT}/scripts/ci-node-http-agent-fix.cjs"
FIREBASE_CLI="${FIREBASE_CLI:-npx --yes firebase-tools@15.22.1}"

# Remote workflow cannot be updated without GitHub `workflow` scope, so Sanoft /
# Sarvam GitHub secrets never reach functions/.env. Merge the encrypted runtime
# file here (and seed Firestore when ADC is present).
if [ -f "$REPO_ROOT/scripts/merge-functions-runtime-env.mjs" ]; then
  node "$REPO_ROOT/scripts/merge-functions-runtime-env.mjs" || echo "::warning::Could not merge Sanoft/Sarvam runtime env."
fi

# --force on functions: delete orphans removed from source (non-interactive) and
# apply Artifact Registry cleanup policy without prompting (see README).
FORCE_FLAG=()
case "$TARGETS" in
  *functions*) FORCE_FLAG=(--force) ;;
esac

if [ -f "$HTTP_AGENT_FIX" ]; then
  export NODE_OPTIONS="--require ${HTTP_AGENT_FIX}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
fi

run_deploy() {
  local debug_flag=()
  if [ "${CI_FIREBASE_DEBUG:-}" = "1" ]; then
    debug_flag=(--debug)
  fi

  if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
    if [ ! -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
      echo "::error::GOOGLE_APPLICATION_CREDENTIALS file not found: $GOOGLE_APPLICATION_CREDENTIALS"
      return 1
    fi

    env -u FIREBASE_TOKEN \
      -u CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE \
      -u GOOGLE_GHA_CREDS_PATH \
      GOOGLE_APPLICATION_CREDENTIALS="$GOOGLE_APPLICATION_CREDENTIALS" \
      NODE_OPTIONS="$NODE_OPTIONS" \
      $FIREBASE_CLI deploy \
      --only "$TARGETS" \
      --project "$PROJECT" \
      --non-interactive \
      "${FORCE_FLAG[@]}" \
      "${debug_flag[@]}"
  else
    if [ -z "${FIREBASE_TOKEN:-}" ]; then
      echo "::error::FIREBASE_TOKEN or GOOGLE_APPLICATION_CREDENTIALS is required."
      return 1
    fi
    env NODE_OPTIONS="$NODE_OPTIONS" \
      $FIREBASE_CLI deploy \
      --only "$TARGETS" \
      --project "$PROJECT" \
      --non-interactive \
      --token "$FIREBASE_TOKEN" \
      "${FORCE_FLAG[@]}" \
      "${debug_flag[@]}"
  fi
}

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "Firebase deploy attempt ${attempt}/${MAX_ATTEMPTS} (--only ${TARGETS})"
  if run_deploy; then
    echo "Deploy succeeded on attempt ${attempt}."
    exit 0
  fi

  if [ "$attempt" -eq 1 ]; then
    echo "Retrying with firebase --debug enabled."
    CI_FIREBASE_DEBUG=1
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::Firebase deploy failed after ${MAX_ATTEMPTS} attempts (--only ${TARGETS})."
    echo "::error::If the log shows \"Premature close\" on oauth2/token, pin Node to 22.23.1+ or 22.22.x in the workflow (nodejs/node#63989)."
    echo "::error::If the log shows HTTP 503 from firebaserules.googleapis.com, this is usually a transient Google outage — re-run the workflow."
    echo "::error::If the log shows HTTP 409 \"Requested entity already exists\" on firebaserules releases, another deploy raced the rules release — re-run once (concurrency should prevent overlaps)."
    exit 1
  fi

  echo "Deploy failed; retrying in ${DELAY}s..."
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
  attempt=$((attempt + 1))
done
