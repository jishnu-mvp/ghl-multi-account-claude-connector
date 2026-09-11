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

# First-run setup for the GoHighLevel + Claude Code connector (macOS / Linux / Git-Bash).
# Creates .env from .env.example if missing, then checks the required values.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env"
EXAMPLE="$REPO_ROOT/.env.example"

echo
echo "=== GoHighLevel + Claude Code setup ==="

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$EXAMPLE" ] || { echo "ERROR: .env.example is missing."; exit 1; }
  cp "$EXAMPLE" "$ENV_FILE"
  echo "Created .env from .env.example."
else
  echo ".env already exists — leaving it as is."
fi

get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' | xargs || true; }

missing=()
for key in GHL_PIT_TOKEN GHL_LOCATION_ID GHL_API_BASE_URL GHL_API_VERSION; do
  [ -z "$(get "$key")" ] && missing+=("$key")
done

token="$(get GHL_PIT_TOKEN)"

echo
if [ ${#missing[@]} -eq 0 ]; then
  echo "All values are set. You are ready."
  case "$token" in
    pit-*) ;;
    *) echo
       echo "NOTE: GHL_PIT_TOKEN does not start with 'pit-'. Private Integration Tokens do."
       echo "      If you pasted an old v1 API key, API v2 calls will fail with 401." ;;
  esac
  echo "Test the API:  ./.claude/skills/ghl/scripts/ghl.sh whoami"
  echo "Launch Claude: ./claude-here.sh"
else
  echo "Still need to fill in: ${missing[*]}"
  echo
  echo "Open .env and set:"
  for k in "${missing[@]}"; do
    case "$k" in
      GHL_PIT_TOKEN)    echo "  GHL_PIT_TOKEN     HighLevel → Settings → Other Settings → Private Integrations"
                        echo "                    → Create new Integration → tick scopes → copy the pit-… token"
                        echo "                    (shown ONCE — if you lose it, create a new integration)" ;;
      GHL_LOCATION_ID)  echo "  GHL_LOCATION_ID   HighLevel → Settings → Business Profile → Location ID" ;;
      GHL_API_BASE_URL) echo "  GHL_API_BASE_URL  https://services.leadconnectorhq.com  (leave as-is)" ;;
      GHL_API_VERSION)  echo "  GHL_API_VERSION   2021-07-28  (leave as-is)" ;;
    esac
  done
  echo
  echo "The same token also authenticates the LeadConnector MCP — there is no second token."
  echo
  echo "Then run  ./setup.sh  again to confirm."
fi
echo
