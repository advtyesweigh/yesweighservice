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
FUNCTIONS_DEPLOY=0
case "$TARGETS" in
  *functions*)
    FORCE_FLAG=(--force)
    FUNCTIONS_DEPLOY=1
    ;;
esac

if [ -f "$HTTP_AGENT_FIX" ]; then
  export NODE_OPTIONS="--require ${HTTP_AGENT_FIX}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
fi

# One function that cannot read a leftover secret must not be retried as a
# full Cloud Run rollout. Grant access first; ignore failure and keep going.
if [ "$FUNCTIONS_DEPLOY" -eq 1 ] && [ -f "$REPO_ROOT/scripts/ci-ensure-runtime-secret-access.mjs" ]; then
  node "$REPO_ROOT/scripts/ci-ensure-runtime-secret-access.mjs" \
    || echo "::warning::Runtime secret access check did not finish."
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

# Shared lib edits touch ~100 Cloud Run services. A full --debug retry of that
# set, then another deploy of every function, is what stretched deploys past
# 45 minutes. Functions get at most 3 attempts, and later attempts deploy only
# the names that failed. Hosting / rules keep the longer backoff.
FUNCTION_MAX_ATTEMPTS="${FIREBASE_FUNCTION_DEPLOY_RETRIES:-3}"
LOG_FILE="$(mktemp)"
trap 'rm -f "$LOG_FILE"' EXIT

fail_deploy() {
  echo "::error::Firebase deploy failed after ${attempt} attempt(s) (--only ${TARGETS})."
  echo "::error::If the log shows \"Premature close\" on oauth2/token, pin Node to 22.23.1+ or 22.22.x in the workflow (nodejs/node#63989)."
  echo "::error::If the log shows HTTP 503 from firebaserules.googleapis.com, this is usually a transient Google outage — re-run the workflow."
  echo "::error::If the log shows HTTP 409 \"Requested entity already exists\" on firebaserules releases, another deploy raced the rules release — re-run once (concurrency should prevent overlaps)."
  echo "::error::If the log shows Permission denied on a secret, grant roles/secretmanager.secretAccessor on that secret to the Cloud Functions runtime service account."
  exit 1
}

narrow_to_failed_functions() {
  local parsed nontransient=0 name joined=""
  parsed="$(node "$REPO_ROOT/scripts/ci-firebase-failed-functions.mjs" "$LOG_FILE" 2>/dev/null || true)"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if [ "$name" = "NONTRANSIENT" ]; then
      nontransient=1
      continue
    fi
    if [ -z "$joined" ]; then
      joined="functions:${name}"
    else
      joined="${joined},functions:${name}"
    fi
  done <<< "$parsed"

  if [ "$nontransient" -eq 1 ] && [ "$attempt" -ge 2 ]; then
    echo "::error::Function deploy failed on a secret permission. Retrying the same functions will not fix it."
    fail_deploy
  fi
  if [ "$nontransient" -eq 1 ] && [ -z "$joined" ]; then
    echo "::error::Function deploy failed on a secret permission before individual functions could be listed."
    fail_deploy
  fi
  if [ -n "$joined" ]; then
    TARGETS="$joined"
    echo "Retrying only the failed function(s): ${TARGETS}"
    return 0
  fi
  if [ "$attempt" -ge 2 ]; then
    echo "::error::Function deploy failed again without a list of failed functions. Not rolling every function out again."
    fail_deploy
  fi
  echo "Function deploy failed before individual functions were listed. Retrying the same target once."
}

attempt=1
limit="$MAX_ATTEMPTS"
if [ "$FUNCTIONS_DEPLOY" -eq 1 ]; then
  limit="$FUNCTION_MAX_ATTEMPTS"
fi

while [ "$attempt" -le "$limit" ]; do
  echo "Firebase deploy attempt ${attempt}/${limit} (--only ${TARGETS})"
  : > "$LOG_FILE"
  set +e
  run_deploy 2>&1 | tee "$LOG_FILE"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    echo "Deploy succeeded on attempt ${attempt}."
    exit 0
  fi

  if [ "$attempt" -eq "$limit" ]; then
    fail_deploy
  fi

  if [ "$FUNCTIONS_DEPLOY" -eq 1 ]; then
    narrow_to_failed_functions
    echo "Deploy failed; retrying failed functions in ${DELAY}s..."
    sleep "$DELAY"
  else
    echo "Deploy failed; retrying in ${DELAY}s..."
    sleep "$DELAY"
    DELAY=$((DELAY * 2))
  fi
  attempt=$((attempt + 1))
done

fail_deploy
