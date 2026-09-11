#!/usr/bin/env bash
# GHL Multi-Account Claude Connector
# Copyright (c) 2026 Jishnu Venugopal. All Rights Reserved.
#
# Proprietary software. You may use this software as-is for your own
# GoHighLevel account(s). You may NOT copy, redistribute, or use this
# code (or any part of it) to build a new or competing product without
# the owner's prior written permission. See LICENSE and NOTICE at the
# repository root for full terms. This notice must not be removed.
# Contact: jishhnnuu@gmail.com

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
