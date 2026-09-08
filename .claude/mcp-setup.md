# MCP servers in this repo

The committed [`.mcp.json`](../.mcp.json) registers **two** MCP servers. Claude Code picks both
up automatically when you open this folder — no `claude mcp add` needed.

| Server | What it is | Setup needed |
|---|---|---|
| **`ghl`** | This repo's own server ([../mcp-server/](../mcp-server/)): ~100 tools over the whole HighLevel API v2, with a **browser login per person** | **None.** Call `ghl_login` and log in |
| **`leadconnector`** | HighLevel's official hosted server | A `pit-…` token in `GHL_PIT_TOKEN` + `GHL_LOCATION_ID`, in the environment |

**Start with `ghl`.** It needs nothing configured, covers more, and enforces this repo's safety
rules in code. See the decision rules in [../CLAUDE.md](../CLAUDE.md).

> **Not using Claude Code at all?** The same connector can be deployed as a hosted service that
> anyone adds by URL from Claude on the web, desktop or mobile — see
> [../remote/README.md](../remote/README.md), and [../PUBLISHING.md](../PUBLISHING.md) for the
> HighLevel marketplace app that turns it into a proper "sign in with HighLevel" button.

---

## `ghl` — log in instead of configuring

```
You:    connect our Kellix iQ account
Claude: (ghl_login) → open http://127.0.0.1:52413/?k=…
You:    (on that page: paste your pit-… token, or click "Log in with HighLevel")
Claude: (ghl_login_status) → Logged in: Kellix iQ (alias "kellixiq")
```

- The page runs on **your** machine and is reachable only from it. What you type is saved to
  `~/.ghl-mcp/credentials.json` (mode `0600`) — never to this repo, never to the chat.
- Paste an **agency-level** token and it lists your sub-accounts and lets you pick.
- **"Log in with HighLevel"** (HighLevel email + password, on HighLevel's own site) appears once
  a marketplace app is configured — a one-time, three-minute job for the agency, which the login
  page walks through. Full detail in [../mcp-server/README.md](../mcp-server/README.md).
- Without a chat at all: `node mcp-server/server.js --login --account kellixiq`.
- **In a cloud / web session the loopback page is unreachable** from your browser. Set that
  account's token and Location ID as environment variables there instead (names in
  [`../accounts.conf`](../accounts.conf)); the `ghl` server reads those too.

Multiple sub-accounts: every `ghl_*` tool takes `account: "<alias>"` and **has no default** — an
omitted account is refused rather than guessed. `ghl_accounts` lists what is connected,
`ghl_whoami` proves one works.

---

## `leadconnector` — HighLevel's hosted server

### What's already configured
The `leadconnector` entry in `.mcp.json`:
```json
{
  "mcpServers": {
    "leadconnector": {
      "type": "http",
      "url": "https://services.leadconnectorhq.com/mcp/anthropic/v2",
      "headers": {
        "Authorization": "Bearer ${GHL_PIT_TOKEN}",
        "locationId": "${GHL_LOCATION_ID}"
      }
    }
  }
}
```

`/mcp/anthropic/v2` is HighLevel's Claude-specific endpoint. Instead of hundreds of individual
tools it exposes a small **discover-then-execute** toolkit over ~40 domains and hundreds of
operations:

| Tool | What it does |
|---|---|
| `search` | Find contacts/businesses by name, email, phone, or tag |
| `fetch` | Full detail for a record you already identified |
| `search_operations` | Discover available operations by intent (list/create/update/delete) |
| `describe_operation` | Get an operation's input schema **before** calling it |
| `execute_operation` | Run an operation, within the token's scopes |
| `list_locations` | List sub-accounts (agency-wide connections) |

`describe_operation` is genuinely useful even when you plan to use the REST API — it returns the
live request shape, which beats guessing a field name and getting a 422.

The token and location are read from the environment variables `GHL_PIT_TOKEN` and
`GHL_LOCATION_ID` — they are **never** hardcoded in this file. That is what makes the folder
safe to share.

> `locationId` is technically optional in the MCP handshake, but HighLevel needs it for any
> sub-account-scoped data. Keep it in the headers rather than hoping a prompt supplies it.

### What to do (once)
1. In HighLevel: **Settings → Other Settings → Private Integrations → Create new Integration**.
   Name it (e.g. `Claude Code — <your name>`), **tick the scopes you need** (see the scope map in
   [skills/ghl/SKILL.md](skills/ghl/SKILL.md#4-scopes-the-1-cause-of-4xx)), then copy the
   `pit-…` token.
   > The token is shown **once** and cannot be retrieved later. It grants access to the
   > sub-account under your identity. Never paste a real token into `.mcp.json` or any
   > committed file.
2. Grab your **Location ID** from **Settings → Business Profile**.
3. Put both in your local `.env` (git-ignored):
   ```
   GHL_PIT_TOKEN=pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   GHL_LOCATION_ID=xxxxxxxxxxxxxxxxxxxx
   ```
   The **same token** serves both the REST API and the MCP — there is no separate MCP token.
4. Make sure both vars are exported into the environment Claude Code runs in. The
   `claude-here` launcher does this for you:
   ```bash
   ./claude-here.sh          # macOS / Linux
   ```
   ```powershell
   .\claude-here.ps1         # Windows
   ```
   If you start `claude` directly, export them manually, e.g.
   - bash: `export GHL_PIT_TOKEN=$(grep '^GHL_PIT_TOKEN=' .env | cut -d= -f2)`
   - PowerShell: `$env:GHL_PIT_TOKEN = ((Get-Content .env | Select-String '^GHL_PIT_TOKEN=') -split '=',2)[1]`
5. Open the folder in Claude Code. Approve the project MCP server when prompted.

## Verify
```bash
claude mcp list        # should list "leadconnector"
```
Or in an interactive session: `/mcp`. If it shows connected, you're set.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `leadconnector` shows **failed** in `/mcp` | The token wasn't in the process environment. Relaunch via `claude-here.sh` / `claude-here.ps1`. |
| Connects, but every tool returns 401 | The token is wrong, expired, rotated, or is an old v1 API key. PITs start with `pit-`. |
| Tools return 403 on some operations only | The Private Integration is missing that **scope**. Add it in Settings → Private Integrations — this issues a **new token**, so update `.env` too. |
| Sub-account data comes back empty | `GHL_LOCATION_ID` is wrong or blank. Check Settings → Business Profile. |
| Agency-wide operations fail | Sub-account PITs cannot do agency-level work. You need an agency-level Private Integration or an OAuth marketplace app. |
| Want OAuth instead of a PIT | HighLevel also supports one-click OAuth on this endpoint (drop the `headers` block and let Claude Code run the consent flow). This repo uses a PIT because it works headlessly and in CI. |

## Working with more than one sub-account

This MCP server is wired to a single sub-account — the one in `GHL_PIT_TOKEN` / `GHL_LOCATION_ID`
(the **default** account in [accounts.conf](../accounts.conf), if you've registered more than
one). For any additional sub-account, Claude uses the `/ghl` skill's REST API scripts with
`--account <alias>` / `-Account <alias>` instead — see
[SKILL.md](skills/ghl/SKILL.md#multiple-sub-accounts) and
[README.md](../README.md#16-working-with-more-than-one-sub-account). You don't need to do
anything differently in conversation; just name the account you mean.

## When it's connected
Claude sees the `leadconnector` tools automatically and follows the API-vs-MCP rules in
[../CLAUDE.md](../CLAUDE.md): MCP for conversational lookup / quick reads / schema discovery,
REST API v2 (via `/ghl`) for everything else.

---

⚠️ **Security note:** a Private Integration Token is a long-lived, non-expiring credential with
whatever scopes you gave it — treat it like a password. If a token has been shared or pasted into
any file that leaves your machine, **delete that integration in HighLevel and create a new one**
(there is no "rotate" that invalidates the old string other than deleting it). HighLevel's own
guidance is to rotate every ~90 days, keeping a short overlap window while you cut over.
