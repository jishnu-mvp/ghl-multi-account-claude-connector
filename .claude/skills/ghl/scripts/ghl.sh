#!/usr/bin/env bash
# GoHighLevel (HighLevel / LeadConnector) API v2 helper for Claude Code
# (macOS / Linux / Git-Bash).
#
# Reads GHL_PIT_TOKEN, GHL_LOCATION_ID, GHL_API_BASE_URL and GHL_API_VERSION from the
# repo-root .env and wraps the common HighLevel API v2 operations.
# Requires: curl. jq optional (pretty output).
#
# Usage:
#   ./ghl.sh whoami
#   ./ghl.sh list-contacts
#   ./ghl.sh get-contact abc123
#   ./ghl.sh raw GET /contacts/?locationId=XXX
#   ./ghl.sh raw POST /contacts/ '{"firstName":"A","locationId":"XXX"}'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- locate repo root (walk up until .env / .env.example) ---
find_repo_root() {
  local dir="$SCRIPT_DIR"
  for _ in $(seq 1 8); do
    [ -f "$dir/.env" ] && { echo "$dir"; return; }
    [ -f "$dir/.env.example" ] && { echo "$dir"; return; }
    local parent
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  echo "$SCRIPT_DIR"
}

REPO_ROOT="$(find_repo_root)"
ENV_FILE="$REPO_ROOT/.env"
ACCOUNTS_FILE="$REPO_ROOT/accounts.conf"

HAS_ENV_FILE=1
[ -f "$ENV_FILE" ] || HAS_ENV_FILE=0
# No .env is fine as long as the token is already a real environment variable (e.g. set via
# a cloud environment's "Environment variables" panel instead of a file) — need_token/need_loc
# below catch the case where it's genuinely missing either way.

# --- multi-account support: --account <alias> picks which token/location env vars to use ---
# Resolved AFTER load_env below (needs the .env values first). Consumed here, before the
# command itself, so it works no matter which command follows.
ACCOUNT_ALIAS=""
if [ "${1:-}" = "--account" ]; then
  [ $# -ge 2 ] || { echo "Usage: --account <alias> <command> [args]  — see accounts.conf" >&2; exit 1; }
  ACCOUNT_ALIAS="$2"; shift 2
fi

# accountrow ALIAS -> prints the matching accounts.conf row (alias|name|tokenVar|locVar), or nothing
accountrow() {
  [ -f "$ACCOUNTS_FILE" ] || return 0
  awk -F'|' -v a="$1" 'BEGIN{IGNORECASE=1} !/^#/ && NF>=4 && $1==a {print; exit}' "$ACCOUNTS_FILE"
}

# accountrow_for_token TOKENVAR -> finds the accounts.conf row whose token var matches (for whoami display)
accountrow_for_token() {
  [ -f "$ACCOUNTS_FILE" ] || return 0
  awk -F'|' -v t="$1" '!/^#/ && NF>=4 && $3==t {print; exit}' "$ACCOUNTS_FILE"
}

# Load .env (ignoring comments/blank lines).
# Deliberately a read loop, NOT `source <(grep …)`: process substitution races under
# bash 3.2 (stock macOS) and can silently export nothing.
load_env() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                    # tolerate CRLF checkouts
    line="${line#"${line%%[![:space:]]*}"}" # ltrim
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # only accept shell-safe identifiers
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    val="${val#"${val%%[![:space:]]*}"}"    # ltrim value
    val="${val%"${val##*[![:space:]]}"}"    # rtrim value
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    # live environment wins over .env
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$1"
}
[ "$HAS_ENV_FILE" = 1 ] && load_env "$ENV_FILE"

GHL_API_BASE_URL="${GHL_API_BASE_URL:-https://services.leadconnectorhq.com}"
GHL_API_VERSION="${GHL_API_VERSION:-2021-07-28}"
API_BASE="${GHL_API_BASE_URL%/}"

# Resolve which token/location env vars to use: --account <alias> picks a row from
# accounts.conf; with no --account, GHL_PIT_TOKEN / GHL_LOCATION_ID (the default row) are
# used, exactly as before this feature existed.
TOKEN_VAR_NAME="GHL_PIT_TOKEN"
LOC_VAR_NAME="GHL_LOCATION_ID"
ACCOUNT_DISPLAY=""
if [ -n "$ACCOUNT_ALIAS" ]; then
  row="$(accountrow "$ACCOUNT_ALIAS")"
  if [ -z "$row" ]; then
    echo "Unknown account alias '$ACCOUNT_ALIAS'. Known accounts:" >&2
    awk -F'|' '!/^#/ && NF>=4 {print "  " $1 " - " $2}' "$ACCOUNTS_FILE" >&2 2>/dev/null
    exit 1
  fi
  ACCOUNT_DISPLAY="$(echo "$row" | cut -d'|' -f2)"
  TOKEN_VAR_NAME="$(echo "$row" | cut -d'|' -f3)"
  LOC_VAR_NAME="$(echo "$row" | cut -d'|' -f4)"
fi
GHL_PIT_TOKEN="${!TOKEN_VAR_NAME:-}"
LOC="${!LOC_VAR_NAME:-}"

# Checked lazily (inside req), not at load time, so `ghl.sh` with no args can still
# print the command list before the developer has configured anything.
need_token() {
  [ -n "${GHL_PIT_TOKEN:-}" ] || { echo "$TOKEN_VAR_NAME is not set — create a Private Integration at Settings → Other Settings → Private Integrations, put its token in that env var, then run ./setup.sh to check." >&2; exit 1; }
}

need_loc() {
  [ -n "$LOC" ] || { echo "$LOC_VAR_NAME is not set — this command needs a sub-account id (Settings → Business Profile)." >&2; exit 1; }
}

pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; fi; }

# req METHOD PATH [BODY]
req() {
  need_token
  local method="$1" path="$2" body="${3:-}"
  local url
  case "$path" in
    http*) url="$path" ;;
    /*)    url="$API_BASE$path" ;;
    *)     url="$API_BASE/$path" ;;
  esac
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $GHL_PIT_TOKEN" \
      -H "Version: $GHL_API_VERSION" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data "$body"
  else
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $GHL_PIT_TOKEN" \
      -H "Version: $GHL_API_VERSION" \
      -H "Accept: application/json"
  fi
}

# read a body from a file path, or pass through inline JSON
body_of() {
  if [ -f "$1" ]; then cat "$1"; else printf '%s' "$1"; fi
}

# escape a plain string into a JSON string literal (incl. surrounding quotes)
json_str() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  else
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

# join remaining args as a JSON string array: a,b  or  a b  ->  ["a","b"]
tags_json() {
  local raw="$*"
  raw="${raw//,/ }"
  local out="" t
  for t in $raw; do out="$out,\"$t\""; done
  echo "[${out#,}]"
}

usage() {
  cat >&2 <<'EOF'
ghl.sh [--account <alias>] <command> [args]   — HighLevel API v2 helper. See SKILL.md.
                Omit --account to use the default sub-account. See accounts.conf for
                the list of known aliases (or add a new one there).

  Connection      whoami | get-location | list-locations
  Contacts        list-contacts [query] | get-contact <id> | search-contacts <file|json>
                  create-contact <file|json> | update-contact <id> <file|json>
                  upsert-contact <file|json> | delete-contact <id> | export-contact <id> [file]
                  add-tags <id> <tags> | remove-tags <id> <tags>
                  contact-notes <id> | add-note <id> <text>
                  contact-tasks <id> | add-task <id> <file|json>
                  contact-appointments <id> | duplicate-check <email>
  Automation      list-workflows | add-to-workflow <contactId> <workflowId>
                  remove-from-workflow <contactId> <workflowId>
                  list-campaigns | add-to-campaign <contactId> <campaignId>
                  remove-from-campaign <contactId> <campaignId>
  Conversations   list-conversations [contactId] | get-conversation <id>
                  messages <conversationId> | get-message <messageId>
                  send-message <file|json> | create-conversation <file|json>
  Opportunities   list-pipelines | search-opportunities [pipelineId]
                  get-opportunity <id> | create-opportunity <file|json>
                  update-opportunity <id> <file|json> | set-opportunity-status <id> <status>
                  delete-opportunity <id>
  Calendars       list-calendars | get-calendar <id>
                  free-slots <calendarId> <startEpochMs> <endEpochMs>
                  list-events <startEpochMs> <endEpochMs> [calendarId]
                  get-appointment <id> | create-appointment <file|json>
                  update-appointment <id> <file|json> | delete-event <id>
  Forms/Surveys   list-forms | form-submissions [formId]
                  list-surveys | survey-submissions [surveyId]
  Location config custom-fields | custom-values | list-tags | list-users | list-custom-menus
  Commerce        list-products | product-prices <productId> | list-invoices
                  list-orders | list-transactions | list-subscriptions
  Content         list-funnels | list-links | list-businesses | list-media
                  list-email-templates | list-blog-sites | list-social-posts
  Escape hatch    raw <METHOD> <path> [file|json]     ← any endpoint, full control
EOF
}

cmd="${1:-}"; shift || true

case "$cmd" in
  ''|-h|--help|help) usage; exit 0 ;;

  # ---------- connection ----------
  whoami)
    if [ -n "$ACCOUNT_DISPLAY" ]; then
      echo "Account    : $ACCOUNT_ALIAS ($ACCOUNT_DISPLAY)"
    else
      defrow="$(accountrow_for_token "$TOKEN_VAR_NAME")"
      if [ -n "$defrow" ]; then
        echo "Account    : $(echo "$defrow" | cut -d'|' -f1) ($(echo "$defrow" | cut -d'|' -f2)) [default]"
      else
        echo "Account    : <not registered in accounts.conf — using default GHL_PIT_TOKEN>"
      fi
    fi
    echo "Base URL   : $API_BASE"
    echo "Version    : $GHL_API_VERSION"
    echo "Location   : ${LOC:-<not set>}"
    tok="${GHL_PIT_TOKEN:-}"
    if [ -n "$tok" ]; then
      echo "Token      : ${tok:0:8}… (${#tok} chars)"
      case "$tok" in pit-*) ;; *) echo "             ⚠️  does not start with 'pit-' — is this really a Private Integration Token?" ;; esac
    else
      echo "Token      : <not set>"
    fi
    echo "Company    : ${GHL_COMPANY_ID:-<not set>}"
    echo
    echo "Probing GET /locations/\$GHL_LOCATION_ID …"
    need_loc
    req GET "/locations/$LOC" | pretty ;;
  get-location)   need_loc; req GET "/locations/$LOC" | pretty ;;
  list-locations)
    # Agency-scoped: needs an AGENCY-level PIT (or OAuth). Will 401/403 on a sub-account token.
    req GET "/locations/search${GHL_COMPANY_ID:+?companyId=$GHL_COMPANY_ID}" | pretty ;;

  # ---------- contacts ----------
  list-contacts)
    need_loc
    if [ $# -ge 1 ]; then req GET "/contacts/?locationId=$LOC&limit=100&query=$1"
    else req GET "/contacts/?locationId=$LOC&limit=100"; fi | pretty ;;
  get-contact)
    [ $# -ge 1 ] || { echo "Usage: get-contact <id>" >&2; exit 1; }
    req GET "/contacts/$1" | pretty ;;
  export-contact)
    [ $# -ge 1 ] || { echo "Usage: export-contact <id> [file]" >&2; exit 1; }
    file="${2:-contact-$1.json}"
    req GET "/contacts/$1" | pretty > "$file"
    echo "Saved contact $1 to $file" ;;
  search-contacts)
    [ $# -ge 1 ] || { echo "Usage: search-contacts <file.json|inline-json>  (body: {locationId,page,pageLimit,filters,sort})" >&2; exit 1; }
    req POST "/contacts/search" "$(body_of "$1")" | pretty ;;
  create-contact)
    [ $# -ge 1 ] || { echo "Usage: create-contact <file.json|inline-json>  (must include locationId)" >&2; exit 1; }
    req POST "/contacts/" "$(body_of "$1")" | pretty ;;
  upsert-contact)
    [ $# -ge 1 ] || { echo "Usage: upsert-contact <file.json|inline-json>" >&2; exit 1; }
    req POST "/contacts/upsert" "$(body_of "$1")" | pretty ;;
  update-contact)
    [ $# -ge 2 ] || { echo "Usage: update-contact <id> <file.json|inline-json>  (do NOT include locationId)" >&2; exit 1; }
    req PUT "/contacts/$1" "$(body_of "$2")" | pretty ;;
  delete-contact)
    [ $# -ge 1 ] || { echo "Usage: delete-contact <id>" >&2; exit 1; }
    req DELETE "/contacts/$1" | pretty ;;
  duplicate-check)
    need_loc
    [ $# -ge 1 ] || { echo "Usage: duplicate-check <email>" >&2; exit 1; }
    req GET "/contacts/search/duplicate?locationId=$LOC&email=$1" | pretty ;;
  add-tags)
    [ $# -ge 2 ] || { echo "Usage: add-tags <contactId> <tag1,tag2>" >&2; exit 1; }
    id="$1"; shift
    req POST "/contacts/$id/tags" "{\"tags\":$(tags_json "$@")}" | pretty ;;
  remove-tags)
    [ $# -ge 2 ] || { echo "Usage: remove-tags <contactId> <tag1,tag2>" >&2; exit 1; }
    id="$1"; shift
    req DELETE "/contacts/$id/tags" "{\"tags\":$(tags_json "$@")}" | pretty ;;
  contact-notes)
    [ $# -ge 1 ] || { echo "Usage: contact-notes <contactId>" >&2; exit 1; }
    req GET "/contacts/$1/notes" | pretty ;;
  add-note)
    [ $# -ge 2 ] || { echo "Usage: add-note <contactId> <text>" >&2; exit 1; }
    id="$1"; shift
    req POST "/contacts/$id/notes" "$(printf '{"body":%s}' "$(json_str "$*")")" | pretty ;;
  contact-tasks)
    [ $# -ge 1 ] || { echo "Usage: contact-tasks <contactId>" >&2; exit 1; }
    req GET "/contacts/$1/tasks" | pretty ;;
  add-task)
    [ $# -ge 2 ] || { echo "Usage: add-task <contactId> <file.json|inline-json>  (body: {title,dueDate,completed,assignedTo})" >&2; exit 1; }
    req POST "/contacts/$1/tasks" "$(body_of "$2")" | pretty ;;
  contact-appointments)
    [ $# -ge 1 ] || { echo "Usage: contact-appointments <contactId>" >&2; exit 1; }
    req GET "/contacts/$1/appointments" | pretty ;;

  # ---------- automation ----------
  list-workflows)
    need_loc; req GET "/workflows/?locationId=$LOC" | pretty ;;
  add-to-workflow)
    [ $# -ge 2 ] || { echo "Usage: add-to-workflow <contactId> <workflowId>" >&2; exit 1; }
    req POST "/contacts/$1/workflow/$2" '{}' | pretty ;;
  remove-from-workflow)
    [ $# -ge 2 ] || { echo "Usage: remove-from-workflow <contactId> <workflowId>" >&2; exit 1; }
    req DELETE "/contacts/$1/workflow/$2" | pretty ;;
  list-campaigns)
    need_loc; req GET "/campaigns/?locationId=$LOC" | pretty ;;
  add-to-campaign)
    [ $# -ge 2 ] || { echo "Usage: add-to-campaign <contactId> <campaignId>" >&2; exit 1; }
    req POST "/contacts/$1/campaigns/$2" '{}' | pretty ;;
  remove-from-campaign)
    [ $# -ge 2 ] || { echo "Usage: remove-from-campaign <contactId> <campaignId>" >&2; exit 1; }
    req DELETE "/contacts/$1/campaigns/$2" | pretty ;;

  # ---------- conversations ----------
  list-conversations)
    need_loc
    if [ $# -ge 1 ]; then req GET "/conversations/search?locationId=$LOC&contactId=$1"
    else req GET "/conversations/search?locationId=$LOC"; fi | pretty ;;
  get-conversation)
    [ $# -ge 1 ] || { echo "Usage: get-conversation <id>" >&2; exit 1; }
    req GET "/conversations/$1" | pretty ;;
  create-conversation)
    [ $# -ge 1 ] || { echo "Usage: create-conversation <file.json|inline-json>  (body: {locationId,contactId})" >&2; exit 1; }
    req POST "/conversations/" "$(body_of "$1")" | pretty ;;
  messages)
    [ $# -ge 1 ] || { echo "Usage: messages <conversationId>" >&2; exit 1; }
    req GET "/conversations/$1/messages" | pretty ;;
  get-message)
    [ $# -ge 1 ] || { echo "Usage: get-message <messageId>" >&2; exit 1; }
    req GET "/conversations/messages/$1" | pretty ;;
  send-message)
    # OUTBOUND SIDE EFFECT — CLAUDE.md requires explicit user confirmation first.
    [ $# -ge 1 ] || { echo "Usage: send-message <file.json|inline-json>  (body: {type:'SMS'|'Email',contactId,message,...})" >&2; exit 1; }
    req POST "/conversations/messages" "$(body_of "$1")" | pretty ;;

  # ---------- opportunities ----------
  list-pipelines)
    need_loc; req GET "/opportunities/pipelines?locationId=$LOC" | pretty ;;
  search-opportunities)
    need_loc
    if [ $# -ge 1 ]; then req GET "/opportunities/search?location_id=$LOC&pipeline_id=$1&limit=100"
    else req GET "/opportunities/search?location_id=$LOC&limit=100"; fi | pretty ;;
  get-opportunity)
    [ $# -ge 1 ] || { echo "Usage: get-opportunity <id>" >&2; exit 1; }
    req GET "/opportunities/$1" | pretty ;;
  create-opportunity)
    [ $# -ge 1 ] || { echo "Usage: create-opportunity <file.json|inline-json>  (body: {locationId,pipelineId,pipelineStageId,name,status,contactId})" >&2; exit 1; }
    req POST "/opportunities/" "$(body_of "$1")" | pretty ;;
  update-opportunity)
    [ $# -ge 2 ] || { echo "Usage: update-opportunity <id> <file.json|inline-json>" >&2; exit 1; }
    req PUT "/opportunities/$1" "$(body_of "$2")" | pretty ;;
  set-opportunity-status)
    [ $# -ge 2 ] || { echo "Usage: set-opportunity-status <id> <open|won|lost|abandoned>" >&2; exit 1; }
    req PUT "/opportunities/$1/status" "{\"status\":\"$2\"}" | pretty ;;
  delete-opportunity)
    [ $# -ge 1 ] || { echo "Usage: delete-opportunity <id>" >&2; exit 1; }
    req DELETE "/opportunities/$1" | pretty ;;

  # ---------- calendars ----------
  list-calendars)
    need_loc; req GET "/calendars/?locationId=$LOC" | pretty ;;
  get-calendar)
    [ $# -ge 1 ] || { echo "Usage: get-calendar <calendarId>" >&2; exit 1; }
    req GET "/calendars/$1" | pretty ;;
  free-slots)
    [ $# -ge 3 ] || { echo "Usage: free-slots <calendarId> <startEpochMs> <endEpochMs>" >&2; exit 1; }
    req GET "/calendars/$1/free-slots?startDate=$2&endDate=$3" | pretty ;;
  list-events)
    need_loc
    [ $# -ge 2 ] || { echo "Usage: list-events <startEpochMs> <endEpochMs> [calendarId]" >&2; exit 1; }
    q="/calendars/events?locationId=$LOC&startTime=$1&endTime=$2"
    [ $# -ge 3 ] && q="$q&calendarId=$3"
    req GET "$q" | pretty ;;
  get-appointment)
    [ $# -ge 1 ] || { echo "Usage: get-appointment <eventId>" >&2; exit 1; }
    req GET "/calendars/events/appointments/$1" | pretty ;;
  create-appointment)
    [ $# -ge 1 ] || { echo "Usage: create-appointment <file.json|inline-json>  (body: {calendarId,locationId,contactId,startTime,...})" >&2; exit 1; }
    req POST "/calendars/events/appointments" "$(body_of "$1")" | pretty ;;
  update-appointment)
    [ $# -ge 2 ] || { echo "Usage: update-appointment <eventId> <file.json|inline-json>" >&2; exit 1; }
    req PUT "/calendars/events/appointments/$1" "$(body_of "$2")" | pretty ;;
  delete-event)
    [ $# -ge 1 ] || { echo "Usage: delete-event <eventId>" >&2; exit 1; }
    req DELETE "/calendars/events/$1" | pretty ;;

  # ---------- forms & surveys ----------
  list-forms)       need_loc; req GET "/forms/?locationId=$LOC" | pretty ;;
  form-submissions) need_loc
                    q="/forms/submissions?locationId=$LOC"
                    [ $# -ge 1 ] && q="$q&formId=$1"
                    req GET "$q" | pretty ;;
  list-surveys)     need_loc; req GET "/surveys/?locationId=$LOC" | pretty ;;
  survey-submissions) need_loc
                    q="/surveys/submissions?locationId=$LOC"
                    [ $# -ge 1 ] && q="$q&surveyId=$1"
                    req GET "$q" | pretty ;;

  # ---------- location config ----------
  custom-fields)    need_loc; req GET "/locations/$LOC/customFields" | pretty ;;
  custom-values)    need_loc; req GET "/locations/$LOC/customValues" | pretty ;;
  list-tags)        need_loc; req GET "/locations/$LOC/tags" | pretty ;;
  list-users)       need_loc; req GET "/users/?locationId=$LOC" | pretty ;;
  list-custom-menus) need_loc; req GET "/custom-menus/?locationId=$LOC" | pretty ;;

  # ---------- commerce ----------
  list-products)    need_loc; req GET "/products/?locationId=$LOC" | pretty ;;
  product-prices)   [ $# -ge 1 ] || { echo "Usage: product-prices <productId>" >&2; exit 1; }
                    need_loc; req GET "/products/$1/price?locationId=$LOC" | pretty ;;
  list-invoices)    need_loc; req GET "/invoices/?altId=$LOC&altType=location&limit=100&offset=0" | pretty ;;
  list-orders)      need_loc; req GET "/payments/orders?altId=$LOC&altType=location" | pretty ;;
  list-transactions) need_loc; req GET "/payments/transactions?altId=$LOC&altType=location" | pretty ;;
  list-subscriptions) need_loc; req GET "/payments/subscriptions?altId=$LOC&altType=location" | pretty ;;

  # ---------- content ----------
  list-funnels)     need_loc; req GET "/funnels/funnel/list?locationId=$LOC" | pretty ;;
  list-links)       need_loc; req GET "/links/?locationId=$LOC" | pretty ;;
  list-businesses)  need_loc; req GET "/businesses/?locationId=$LOC" | pretty ;;
  list-media)       need_loc; req GET "/medias/files?altId=$LOC&altType=location" | pretty ;;
  list-email-templates) need_loc; req GET "/emails/builder?locationId=$LOC" | pretty ;;
  list-blog-sites)  need_loc; req GET "/blogs/site/all?locationId=$LOC&limit=50&skip=0" | pretty ;;
  list-social-posts) need_loc; req POST "/social-media-posting/$LOC/posts/list" '{"limit":20,"skip":0}' | pretty ;;

  # ---------- escape hatch ----------
  raw)
    [ $# -ge 2 ] || { echo "Usage: raw <METHOD> <path> [file.json|inline-json]" >&2; exit 1; }
    m="$1"; p="$2"; shift 2
    if [ $# -ge 1 ]; then req "$m" "$p" "$(body_of "$1")"; else req "$m" "$p"; fi | pretty ;;

  *)
    echo "Unknown command '$cmd'." >&2
    usage
    exit 1 ;;
esac
