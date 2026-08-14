#!/usr/bin/env bash
# Load .env into the environment, then launch Claude Code in this folder.
# .mcp.json references ${GHL_PIT_TOKEN} and ${GHL_LOCATION_ID}; those vars must exist in the
# environment Claude Code runs in, or the leadconnector MCP server will not connect.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env found. Run  ./setup.sh  first."
  exit 1
fi

# Load .env into the environment. Deliberately a read loop, NOT `source <(grep …)`:
# process substitution races under bash 3.2 (stock macOS) and can silently export nothing.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  if [ -z "${!key:-}" ]; then
    export "$key=$val"
  fi
done < "$ENV_FILE"

if [ -z "${GHL_PIT_TOKEN:-}" ]; then
  echo "WARNING: GHL_PIT_TOKEN is empty — the LeadConnector MCP will not connect, and the"
  echo "         /ghl API helper scripts will fail too. Set it in .env (Settings → Other"
  echo "         Settings → Private Integrations)."
elif [ -z "${GHL_LOCATION_ID:-}" ]; then
  echo "WARNING: GHL_LOCATION_ID is empty — sub-account-scoped calls will fail."
  echo "         Set it in .env (Settings → Business Profile → Location ID)."
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI (claude) not found on PATH. Install it, then rerun."
  exit 1
fi

echo "Launching Claude Code with GoHighLevel env loaded..."
exec claude "$@"
