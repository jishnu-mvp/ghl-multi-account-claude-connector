# GoHighLevel CRM — Working Rules for Claude Code

This repo connects Claude Code to a GoHighLevel (HighLevel / LeadConnector) sub-account. Any
Claude Code session working here MUST follow the rules below.

You have **four ways** to reach GoHighLevel. The first two are this repo's own; both share one
tool layer, so they behave identically.

1. **The `ghl` MCP server** (in [mcp-server/](mcp-server/), registered in [.mcp.json](.mcp.json)) —
   for a Claude Code session on this repo. Covers the whole surface below as ~100 tools, and
   each person **logs in with their own GoHighLevel credentials in a browser** (`ghl_login`)
   instead of a token being placed in `.env` first. Nothing to install or configure; it
   enforces the safety rules on this page in code. **Start here in a Claude Code session.**
2. **The hosted connector** (in [remote/](remote/)) — the same tools served over HTTPS as a
   remote MCP server, for people who never touch this repo or Claude Code. They add its URL in
   Claude (web, desktop, mobile), Cursor or any MCP client, sign in with their **own HighLevel
   email and password**, tick the sub-accounts to share — and, if they work across more than
   one HighLevel agency, sign in again and add that CRM's sub-accounts to the same connection.
   Deploy notes in [remote/README.md](remote/README.md); the marketplace app that makes the
   sign-in possible is in [PUBLISHING.md](PUBLISHING.md) and is **required** for this route.
3. **HighLevel API v2 (REST)** via the `/ghl` skill's helper scripts — the same API, driven from
   the shell. Still the right tool for scripted, bulk and CI work, and for a cloud session where
   a browser login is impossible. Authenticates with a **Private Integration Token** (`pit-…`)
   from the environment or `.env`.
4. **LeadConnector MCP** — a smaller discover-then-execute toolkit hosted by HighLevel, also on
   the Private Integration Token.

All four talk to the same API v2. **Read the decision rules below and pick the right one every
time.**

---

## Golden rule: when to use what

| Situation | Use |
|---|---|
| Anything in a chat: look someone up, read a timeline, tag a contact, move an opportunity, check a calendar, send a message | **`ghl` MCP server** (`ghl_*` tools) |
| Nobody has connected the account yet | **`ghl` MCP server** — `ghl_login`, then `ghl_login_status`. No `.env`, no relaunch |
| An endpoint with no typed tool | **`ghl` MCP server** — `ghl_search_operations` → `ghl_describe_operation` → `ghl_request` |
| Bulk / scripted ops (export every contact, batch tag, migrate, dedupe, reconcile) | **REST API** via `/ghl` helper scripts |
| CI/CD, cron syncs, reproducible runs, anything that must work with no human present | **REST API** via `/ghl` helper scripts |
| A cloud / web session, where a `127.0.0.1` login page is unreachable | **REST API** with that account's environment variables |
| Someone who will never open this repo — a client, a teammate on their phone | **the hosted connector**: they add its URL in their own assistant and authorise it themselves |
| Conversational lookup when you would rather use HighLevel's own hosted toolkit | **LeadConnector MCP** (`search` → `fetch`) |
| Discovering an operation's live input schema straight from HighLevel | **LeadConnector MCP** (`search_operations` → `describe_operation`) |

**Default: the `ghl` MCP server.** It is the complete surface (typed tools plus
`ghl_request`), it is the only path that needs no prior setup, and it enforces the rules below
rather than trusting them to be remembered. Drop to the `/ghl` helper scripts for scripted and
bulk work, or when a browser login cannot happen. If a `ghl_*` tool errors, read what it says —
it names the account, the request and the scope — rather than switching channels and retrying.

### The `ghl` MCP server (this repo's own)
- ✅ ~100 tools across contacts, tags, notes, tasks, conversations & messaging, opportunities &
  pipelines, calendars & appointments, workflows & campaigns, forms, surveys, custom fields &
  values, users, products, invoices, payments, media, funnels, links, businesses, blogs, social
- ✅ `ghl_search_operations` → `ghl_describe_operation` → `ghl_request` reaches **every** API v2
  endpoint, catalogued or not — so it is a superset, not a subset
- ✅ **Browser login per person** — `ghl_login` returns a `127.0.0.1` link; they paste their own
  Private Integration Token, or sign in with their HighLevel email and password where the
  marketplace app is configured. The credential never enters the chat or the repo
- ✅ Multi-account by design: every tool takes an `account` alias and **has no default**
- ✅ Reads the existing `accounts.conf` + environment variables too, so nothing that worked
  before stops working
- ❌ The login page is loopback-only — no use in a cloud/web session (use env vars there)
- ❌ Cannot exceed the credential's scopes; a missing scope is a hard 401/403, not a retry
- ⚠️ Full email/password sign-in needs a HighLevel marketplace app registered once by the
  agency — see [mcp-server/README.md](mcp-server/README.md). The token path needs nothing

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

**In a chat, prefer the `ghl` MCP server's tools** — they inject `locationId` the way each
endpoint expects, gate the dangerous calls, and back records up before changing them.

**For scripted or bulk work, do not hand-write curl from scratch.** Use the `/ghl` skill — it has ready helper scripts
(PowerShell for Windows, bash for macOS/Linux) covering contacts, tags, notes, tasks,
conversations & messaging, opportunities & pipelines, calendars & appointments, forms, surveys,
custom fields, users, workflows, campaigns, products, invoices, payments, media and more, plus
the full endpoint reference and the scope→endpoint map.

Invoke it with `/ghl`, or read [.claude/skills/ghl/SKILL.md](.claude/skills/ghl/SKILL.md).

### Connection

**Through the `ghl` MCP server (no setup):** call `ghl_login`, hand the user the link, they log
in in their browser. Credentials are stored per-user in `~/.ghl-mcp/credentials.json` (mode
`0600`), never in this repo. Nothing to copy, commit or relaunch.

**For the helper scripts, the LeadConnector MCP, or a cloud session (one-time):**
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

- **The `ghl` MCP server's tools all take `account: "<alias>"` and have no default at all** —
  an omitted account is refused with the list of aliases to ask about. Aliases come from
  `ghl_accounts`, which merges browser logins with the `accounts.conf` rows.
- **The `/ghl` skill's helper scripts take `--account <alias>` / `-Account <alias>`.** Omitting
  it uses the default account (the row whose token env var is `GHL_PIT_TOKEN`).
- **The LeadConnector MCP only ever talks to the default account.** For any other configured
  account, use the API (`--account`/`-Account`) — never assume the MCP tools are looking at the
  account the user just mentioned.
- **Never fetch, read, or act on GHL data unless the user has named the account in that same
  request — no exceptions, and no silent default, even when only one account is configured.**
  "Show me our tags" with no client named is not a request to act on — it's a request to ask
  "which account: MVP Ventures or Kellix iQ?" first. Only a message that itself names the
  account (or unambiguously implies it, e.g. continuing a thread that already named one) may be
  acted on. This applies to every read and every write, not just writes. Two real businesses'
  contacts, conversations, and money live behind these accounts; a mixed-up account is the same
  category of mistake as a mixed-up contact.
- **Always state which account you used, by display name, in the response itself** — don't
  make the user infer it from context.
- **Adding an account is additive, not a re-setup.** Easiest: `ghl_login` with a new alias —
  the person logs in and it is available immediately, with no file to edit. For the helper
  scripts: new Private Integration in that sub-account → its token/location go into two new env
  vars with a unique suffix → one new row in `accounts.conf`. No new environment, no new chat,
  no code changes either way.

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

- **The REST API v2 is the source of truth.** The `ghl` MCP server is a typed, safety-enforcing
  wrapper over exactly that API — nothing more. Never let a third-party MCP's behaviour override
  the rules above.
- **The `ghl` MCP server is the default channel in a chat**, and the `/ghl` helper scripts are
  the default for scripted and bulk work. Keep the two in step: an endpoint added to one should
  be reachable from the other (the server's `ghl_request` covers this automatically).
- **There is ONE tool layer** ([mcp-server/src/tools/](mcp-server/src/tools/)), serving both the
  local stdio server and the hosted connector. Add a tool once and both get it. The only
  per-deployment difference is the session tools (`session.js` vs `remote-session.js`).
- **Credentials reach the tools through [context.js](mcp-server/src/context.js)**
  (AsyncLocalStorage), never a module-level "current account". That is what keeps the hosted
  server's concurrent tenants isolated — do not add an ambient credential global.
- **The hosted connector's connect flow accumulates and is finished explicitly.** Sign-in is
  repeatable (once per CRM), each sign-in's sub-account picks are added to what is already
  attached, and **only `/oauth/connect/finish` issues an authorization code**. Do not make a
  sign-in or a selection hand a code back: that would cap a connection at one CRM, which is
  the bug the flow exists to avoid. Signing in to the next agency must clear the previous
  one's pending picker.
- **The multi-CRM option stays proportional to the evidence for it.** Most people have one
  HighLevel account, so the review screen leads with Finish and keeps "sign in to another
  CRM" behind a collapsed `<details>` — open only once two CRMs are attached. A login that
  covers exactly one sub-account skips the checklist altogether. Do not promote either back
  into the main flow: capability the multi-CRM person needs must not become friction the
  single-CRM person pays for.
- **Aliases are computed per grant, not stored.** Two agencies can each have a "Bluebird
  Childcare", so [tenants.js](remote/src/tenants.js) qualifies a colliding alias with the CRM
  (`bluebird-childcare-kellix`) and only then falls back to an id fragment. Never resolve an
  account by display name alone, and never let an alias from one grant be visible in another.
- **The hosted connector is its own OAuth 2.1 authorization server** and must stay compliant:
  PKCE S256 only, exact redirect matching, public clients only, rotating refresh tokens with
  reuse detection, and tokens bound to its own resource URI. Never forward a client's token to
  HighLevel; the HighLevel credential is separate and stays server-side.
- **One connection, one credential.** Two people authorising the same sub-account get two
  separate tenant records. Never make connections share a stored credential — one person's
  calls must never run under another's token.
- **Two authentication mechanisms are supported, both the user's own credential:** a
  **Private Integration Token**, and **HighLevel OAuth 2.0** through a marketplace app. The
  hosted connector defaults to OAuth only — `ALLOW_TOKEN_CONNECT` is `false`, so nobody is
  asked to paste a token — while the local server and the helper scripts still take either. Do not introduce a v1 API key,
  a v1 `Bearer` JWT, or a third-party GHL MCP without explicit agreement.
- **Credentials are per person and live outside the repo** — `~/.ghl-mcp/credentials.json` at
  mode `0600`, or environment variables. Never a tracked file, never the chat transcript.
- **The `ghl` MCP server has no dependencies and no build step**, and its safety rules
  (account required, confirm-before-outbound, read-before-write, token redaction, rate limit)
  are code with tests behind them. Do not weaken them for convenience; `npm test --prefix
  mcp-server` must stay green.
- **`.mcp.json` reads its credentials from `${GHL_PIT_TOKEN}` / `${GHL_LOCATION_ID}`.** Never
  hardcode them into it.
- **Secrets live only in `.env`** (git-ignored), never in committed files, exports, or logs.
- **This is a tooling/connector repo.** Keep CRM *data* (contact exports, CSVs, conversation
  dumps) out of it — `.gitignore` already excludes the common ones.
- **The app stays a Node `(req, res)` handler.** [serverless.js](remote/src/serverless.js) is
  the single place that adapts it to Web `Request`/`Response` for Netlify-style platforms —
  do not fork the router or write a second app for a platform. The test suite re-runs the
  whole flow through that adapter as well as over a socket, so keep it that way.
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
- ❌ Passing `confirm: true` to a `ghl_*` tool on the user's behalf — that flag represents a
  human saying yes to this exact action, after seeing the dry run.
- ❌ Asking the user to paste a `pit-…` token into the chat. Send them through `ghl_login`
  instead, so the credential never enters the transcript.
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
- **The `ghl` MCP server:** Node ≥ 18 and nothing else — no npm dependencies, no build. Speaks
  MCP over stdio; `node mcp-server/server.js --list` and `npm test --prefix mcp-server` need no
  credentials.
- **HighLevel OAuth (optional, for email/password login):** a marketplace app at
  `marketplace.gohighlevel.com` (client id + secret). **The redirect URL must be HTTPS** —
  HighLevel rejects plain HTTP — so it points at the hosted connector
  (`<PUBLIC_URL>/highlevel/callback`), not at a loopback port. Access tokens last ~24h;
  refresh tokens are valid a year **or until used**, and using one invalidates it, so the
  replacement must be stored (both servers do). HighLevel has no dynamic client registration,
  so the app is created once by the agency — see [PUBLISHING.md](PUBLISHING.md).
- **The hosted connector:** Node ≥ 18, no dependencies. Needs `PUBLIC_URL` (its HTTPS origin,
  which is the OAuth issuer and token audience) and `ENCRYPTION_KEY` (32 bytes; losing it makes
  stored connections unreadable). Docker image and compose file included, plus Netlify and
  Vercel entry points. On either serverless platform a Redis store (Upstash REST) is
  **required** — the filesystem is wiped between invocations — and `TRUST_PROXY=true`, or the
  rate limiter sees one address for every caller.

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
PUBLISHING.md                  ← how to publish the HighLevel marketplace app (hosted connector)
mcp-server/                    ← the `ghl` MCP server: browser login + ~100 tools, zero deps
  server.js                    ← entry point (stdio MCP; also --login and --list)
  src/                         ← protocol, API client, login pages, safety rails, tools/
  src/context.js               ← per-request credential binding (what makes the tools multi-tenant)
  test/run.js                  ← 65 self-tests, no credentials required
  README.md                    ← how the server and its login flow work
remote/                        ← the hosted connector: same tools over HTTPS, OAuth 2.1
  server.js                    ← entry point (also --check to validate configuration)
  src/oauth/                   ← discovery, dynamic registration, codes, tokens, authorize
  src/transport.js             ← MCP over Streamable HTTP + legacy SSE
  src/serverless.js            ← Web Request/Response adapter (Netlify-style platforms)
  src/storage/                 ← file | redis backends behind one interface
  Dockerfile / docker-compose.yml / .env.example
  test/run.js                  ← 83 self-tests against a real HTTP server
  test/storage.js              ← 31 more, against both storage backends
  README.md                    ← deploy, security properties, operating notes
netlify.toml + netlify/        ← deploy the hosted connector to Netlify (Functions v2)
vercel.json + api/index.js     ← deploy the same thing to Vercel (Node handler)
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
