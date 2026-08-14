# GoHighLevel CRM — Working Rules for Claude Code

This repo connects Claude Code to a GoHighLevel (HighLevel / LeadConnector) sub-account. Any
Claude Code session working here MUST follow the rules below.

You have **two ways** to reach GoHighLevel, and **both authenticate with the same credential**:
a **Private Integration Token** (`pit-…`) generated in the sub-account.

1. **HighLevel API v2 (REST)** — full-power, scriptable. Use for anything programmatic.
2. **LeadConnector MCP** — a smaller discover-then-execute toolkit hosted by HighLevel.

They overlap but are not equal. The API can do more; the MCP is a convenience layer. **Read the
decision rules below and pick the right one every time.**

---

## Golden rule: when to use what

| Situation | Use |
|---|---|
| Bulk / scripted ops (list all contacts, batch tag, export, migrate, dedupe, reconcile) | **REST API** |
| Precise field-level writes, custom fields & custom values, tag vocabulary | **REST API** |
| Anything the MCP toolkit doesn't cover or covers awkwardly (forms/survey submissions, media, blogs, funnels, invoices, email templates, users) | **REST API** |
| CI/CD, cron syncs, automated tests, reproducible runs | **REST API** |
| Conversational "find the contact for jane@example.com" / "what's in their timeline?" | **MCP** (`search` → `fetch`) |
| Quick one-off read mid-chat where exact shape doesn't matter | **MCP** |
| Discovering an operation's input schema before you write a request | **MCP** (`search_operations` → `describe_operation`) |
| You're unsure whether the MCP covers it | **Try the API** — it is the superset |

**Default: reach for the REST API v2.** The MCP is a convenience layer for conversational
lookup and schema discovery; the API is the complete surface. If an MCP tool errors, is
missing, or is restricted, immediately fall back to the API via the `/ghl` skill.

### What the LeadConnector MCP can do (and its limits)
- ✅ `search` / `fetch` — find and read contacts and business records conversationally
- ✅ `search_operations` / `describe_operation` — discover operations and their **live input
  schemas** (useful even when you'll ultimately call the REST API)
- ✅ `execute_operation` — run hundreds of operations across ~40 domains, within the token's scopes
- ✅ `list_locations` — enumerate sub-accounts on an agency-wide connection
- ❌ Nothing outside the token's scopes — a missing scope is a hard 403, not a retry
- ❌ No guaranteed bulk/pagination semantics or raw-JSON round-tripping
- ⚠️ Hosted by HighLevel; the operation catalogue changes without notice — treat as best-effort

> This repo ships a committed [.mcp.json](.mcp.json) that registers the `leadconnector`
> server at `https://services.leadconnectorhq.com/mcp/anthropic/v2`. It connects automatically
> once you set your own `GHL_PIT_TOKEN` and `GHL_LOCATION_ID` (see
> [.claude/mcp-setup.md](.claude/mcp-setup.md)). If they aren't set, the MCP won't connect —
> use the API only until they are.

---

## How to actually call the API

**Do not hand-write curl from scratch.** Use the `/ghl` skill — it has ready helper scripts
(PowerShell for Windows, bash for macOS/Linux) covering contacts, tags, notes, tasks,
conversations & messaging, opportunities & pipelines, calendars & appointments, forms, surveys,
custom fields, users, workflows, campaigns, products, invoices, payments, media and more, plus
the full endpoint reference and the scope→endpoint map.

Invoke it with `/ghl`, or read [.claude/skills/ghl/SKILL.md](.claude/skills/ghl/SKILL.md).

### Connection (one-time)
1. Copy `.env.example` → `.env` and fill in your own values.
2. Get your token from HighLevel: **Settings → Other Settings → Private Integrations →
   Create new Integration** → tick scopes → copy the `pit-…` token (**shown once**).
3. Get your **Location ID** from **Settings → Business Profile**.
4. Never commit `.env`. It is git-ignored.

```
GHL_PIT_TOKEN=pit-xxxxxxxx-…        # sent as Authorization: Bearer <token>
GHL_LOCATION_ID=<sub-account id>    # required by nearly every endpoint
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28          # sent as the Version header — REQUIRED
```

The helper scripts read these from `.env` automatically. Three headers are mandatory on every
API v2 call: `Authorization: Bearer …`, `Version: 2021-07-28`, and `Content-Type:
application/json` on writes. **A missing `Version` header is the most common mystery 4xx.**

---

## Multiple sub-accounts

This connector can serve more than one GHL sub-account from a single ongoing session —
[accounts.conf](accounts.conf) at the repo root is the registry (alias, display name, and which
env vars hold that account's token/location; no secrets in that file, it's safe to read/commit).

- **The `/ghl` skill's helper scripts take `--account <alias>` / `-Account <alias>`.** Omitting
  it uses the default account (the row whose token env var is `GHL_PIT_TOKEN`).
- **The LeadConnector MCP only ever talks to the default account.** For any other configured
  account, use the API (`--account`/`-Account`) — never assume the MCP tools are looking at the
  account the user just mentioned.
- **Never fetch, read, or act on GHL data unless the user has named the account in that same
  request — no exceptions, and no silent default, even when only one account is configured.**
  "Show me our tags" with no client named is not a request to act on — it's a request to ask
  "which account: MVP Ventures or Client A?" first. Only a message that itself names the
  account (or unambiguously implies it, e.g. continuing a thread that already named one) may be
  acted on. This applies to every read and every write, not just writes. Two real businesses'
  contacts, conversations, and money live behind these accounts; a mixed-up account is the same
  category of mistake as a mixed-up contact.
- **Always state which account you used, by display name, in the response itself** — don't
  make the user infer it from context.
- **Adding an account is additive, not a re-setup.** New Private Integration in that sub-account
  → its token/location go into two new env vars with a unique suffix → one new row in
  `accounts.conf`. No new environment, no new chat, no code changes.

---

## Working rules for GHL changes

1. **Read before you write.** Fetch the current record (`get-contact`, `get-opportunity`,
   `get-appointment`) before editing. Never blind-overwrite.
2. **Back up before destructive ops.** Export the record to a local JSON file before update or
   delete. The skill's `export-contact` helper does this. Exports are git-ignored — they're PII.
3. **This CRM contains real customers.** Every write can reach a human being. Treat contacts,
   conversations, and appointments as production data at all times; there is no sandbox and no
   undo.
4. **Confirm anything outbound.** Sending a message, booking/cancelling an appointment, or
   enrolling a contact in a workflow or campaign contacts a real person — get explicit
   confirmation first, every time, unless already told to do exactly that.
5. **Never bulk-mutate on your own initiative.** State the count and the exact change, get a
   go-ahead, then do it in batches with rate limits in mind.
6. **Don't leak secrets or PII.** Contact records, conversation transcripts, and form
   submissions contain personal data. Never paste raw payloads into commits, tickets, or
   external services, and never print the token.
7. **Fetch ids, don't guess them.** Pipeline stage ids, custom field ids, calendar ids and
   workflow ids are opaque. `list-pipelines` / `custom-fields` / `list-calendars` first.
8. **A 401/403 means a missing scope — stop and report it.** Don't retry, and don't probe
   alternative endpoints hoping one is permitted. Name the scope that must be added, and remind
   that adding scopes issues a **new** token that must go into `.env`.
9. **Verify by re-reading.** After a change, fetch the record again rather than trusting the
   write response.
10. **Respect rate limits.** ~100 requests / 10 seconds and ~200k / day per app+location is the
    documented budget. A 429 means back off and batch — never retry-hammer.

---

## Coding standards & conventions

- **Private Integration name:** `Claude Code — <your name>` so tokens are traceable in the
  HighLevel audit trail.
- **Tags:** `kebab-case`, agreed vocabulary only. Check `list-tags` before inventing a tag —
  HighLevel creates tags implicitly on write and a typo becomes permanent clutter.
- **Custom fields:** reference by **id**, resolved via `custom-fields` at runtime. Never
  hardcode a field id in a tracked script; never assume a field key.
- **Pipelines / stages:** never hardcode stage ids. Resolve `list-pipelines` → match by name.
- **Exported JSON files:** `contact-<id>.json`, `opportunity-<id>.json`, `export-<slug>.json`
  (already git-ignored — they contain PII).
- **Shell scripts:** PowerShell for Windows + bash twin for macOS/Linux; keep both in sync,
  command-for-command.

## Testing patterns

- **Test against a throwaway contact you created**, never a real customer. Create it, exercise
  the flow, delete it. Name test records with a `zzz-test-` prefix so they're obvious.
- **Dry-run first.** For anything that writes, print the exact request body and the target
  record and get confirmation before firing it.
- **Read-back verification is mandatory:** after every write, `get-*` the record and confirm
  the field actually changed. The API returning 200 is not proof.
- **Never test messaging against a real contact.** Use your own phone/email as the target.
- Before any bulk job, run it against **one** record end-to-end, show the result, then scale.
- `whoami` is the smoke test for connectivity, token validity, and location correctness — run
  it first when anything looks wrong.

## Architecture decisions Claude must respect

- **The REST API v2 is the source of truth and the default channel.** The MCP is a convenience
  layer only — never let MCP behaviour override the API-vs-MCP rules above.
- **Authentication is a Private Integration Token, not OAuth and not a v1 API key.** Don't
  introduce an OAuth app, a v1 `Bearer` JWT, or a third-party GHL MCP without explicit agreement.
- **`.mcp.json` reads its credentials from `${GHL_PIT_TOKEN}` / `${GHL_LOCATION_ID}`.** Never
  hardcode them into it.
- **Secrets live only in `.env`** (git-ignored), never in committed files, exports, or logs.
- **This is a tooling/connector repo.** Keep CRM *data* (contact exports, CSVs, conversation
  dumps) out of it — `.gitignore` already excludes the common ones.
- **Cross-platform parity:** every helper ships PowerShell + bash; the SessionStart hook runs
  under `node` (exec form) to stay OS-agnostic. Preserve this.
- Do not restructure `.claude/`, the skill, the hooks, or the launch flow without discussing it
  first — it's meant to stay stable across sessions.

## Claude is explicitly prohibited from

- ❌ Fetching, reading, or acting on any GHL account's data when the user's request didn't name
  which account they mean — ask instead of defaulting, even if only one account is configured.
- ❌ Committing, printing, or transmitting `GHL_PIT_TOKEN`, or raw contact / conversation /
  form-submission payloads (they contain PII).
- ❌ Hardcoding any token or location id into `.mcp.json`, `settings.json`, or any tracked file.
- ❌ Sending an SMS, email, or any message to a contact **without explicit user confirmation**.
- ❌ Creating, rescheduling, or cancelling appointments **without explicit user confirmation**.
- ❌ Enrolling or removing contacts from workflows/campaigns **without explicit user
  confirmation** — enrolment fires live automations.
- ❌ Deleting contacts, opportunities, or appointments, or bulk-updating records, **without
  explicit user confirmation** and a prior export.
- ❌ Overwriting a record without first fetching and backing up its current state.
- ❌ Retrying or working around a 401/403 instead of reporting the missing scope.
- ❌ Creating tags, custom fields, pipelines, or stages as a side effect of another task.
- ❌ Touching agency-level resources (sub-account creation, snapshots, SaaS billing) unless
  explicitly asked **and** holding an agency-level token.

## Dependencies & version constraints

- **HighLevel API v2:** base `https://services.leadconnectorhq.com`, header
  `Authorization: Bearer <pit-token>`, header `Version: 2021-07-28` (a few legacy endpoints
  want `2021-04-15`). No `/v2` path segment. Reference:
  <https://marketplace.gohighlevel.com/docs/>.
- **Auth:** Private Integration Token, created per sub-account under
  **Settings → Other Settings → Private Integrations**. Long-lived, non-expiring, scope-limited,
  shown once. Sub-account PITs cannot perform agency-level operations.
- **LeadConnector MCP:** `https://services.leadconnectorhq.com/mcp/anthropic/v2` (HighLevel's
  Claude-specific endpoint), HTTP transport, same PIT via `Authorization: Bearer` plus a
  `locationId` header. Operation catalogue is subject to change.
- **Rate limits:** ~100 requests / 10 s burst and ~200,000 / day per app+location. Verify the
  current published figures before designing a large sync.
- **Node.js:** required (ships with Claude Code) — the SessionStart hook depends on it.
- **PowerShell 5.1+** (Windows) and **bash** (macOS/Linux/Git-Bash) for the helper scripts;
  `curl` required for the bash helper, `jq` optional for pretty output.
- **Claude Code** with project MCP support (`.mcp.json`) and hooks (`settings.json`).

---

## Repo layout

```
CLAUDE.md                      ← you are here (working rules)
README.md                      ← human onboarding
setup.ps1 / setup.sh           ← first-run: scaffold .env, check token + location
claude-here.ps1 / .sh          ← launch Claude with .env loaded (MCP credentials available)
.env.example                   ← copy to .env, fill in your token
accounts.conf                  ← registry of GHL sub-accounts this connector knows about
.mcp.json                      ← registers the LeadConnector MCP (creds from ${GHL_PIT_TOKEN})
.gitignore                     ← keeps .env, exports and CRM data out of git
.gitattributes                 ← LF for *.sh so they run on Windows checkouts
.claude/
  settings.json                ← wires the SessionStart env-check hook
  mcp-setup.md                 ← how the LeadConnector MCP is configured + troubleshooting
  hooks/
    check-ghl-env.js           ← SessionStart hook: warns if .env/token/location missing
  skills/
    ghl/
      SKILL.md                 ← /ghl skill: API guide, endpoint reference, scope map
      scripts/
        ghl.ps1                ← PowerShell helper (Windows)
        ghl.sh                 ← bash helper (macOS/Linux)
```

---

## Style
- Windows shells here are PowerShell; scripts also ship a bash version. Match the platform.
- Reference files as clickable links, e.g. [SKILL.md](.claude/skills/ghl/SKILL.md).
- Keep CRM data (contact exports, CSVs, conversation dumps) OUT of this repo — this is
  tooling only, and that data is PII.
