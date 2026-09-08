# `ghl` — the GoHighLevel MCP server

An MCP server that gives Claude the whole of this repo's GoHighLevel surface, where **each
person logs in with their own GoHighLevel credentials in a browser** instead of a token being
planted in `.env` before anyone can start.

- **101 tools** (35 with `GHL_MCP_TOOLSET=core`) covering contacts, tags, notes, tasks,
  conversations and messaging, opportunities and pipelines, calendars and appointments,
  workflows and campaigns, forms, surveys, custom fields and values, users, products,
  invoices, payments, media, funnels, links, businesses, blogs and the social planner — plus a
  167-entry endpoint catalogue and a raw escape hatch, so nothing in the API is out of reach.
- **A hosted twin** in [../remote/](../remote/) sharing this exact tool layer, for people who
  will never open this repository.
- **Zero dependencies.** Plain Node ≥ 18, no `npm install`, no build step.
- **No `.env`, no environment variables, no relaunch.** Credentials are captured by a login
  page on `127.0.0.1` and stored per-user in `~/.ghl-mcp/credentials.json` (mode `0600`),
  outside this repository.
- **The connector's safety rules are enforced in code**, not left to prompt discipline.

## Using it

Nothing to install. Claude Code picks the server up from the committed
[`.mcp.json`](../.mcp.json) when you open this folder.

```
You:    connect our Kellix iQ account
Claude: (calls ghl_login) → open http://127.0.0.1:52413/?k=…
You:    (paste your pit-… token on that page, or click "Log in with HighLevel")
Claude: (calls ghl_login_status) → Logged in: Kellix iQ (alias "kellixiq")
You:    how many contacts tagged vip does Kellix iQ have?
```

Or log in with no chat involved:

```bash
node mcp-server/server.js --login --account kellixiq
node mcp-server/server.js --list      # what the server exposes
npm test --prefix mcp-server          # 65 self-tests, no credentials needed
```

## The two ways to log in

**1. Private Integration Token — works immediately, nothing to set up.**
HighLevel → *Settings → Other Settings → Private Integrations → Create new Integration*, tick
the scopes, copy the `pit-…` token, paste it into the login page. The page verifies it against
HighLevel, reads the business name back so Claude can name the client correctly, and stores it.
Paste an **agency-level** token and it lists your sub-accounts and lets you pick.

**2. "Log in with HighLevel" (OAuth) — real email-and-password sign-in.**
The person is sent to `marketplace.gohighlevel.com`, signs in with their HighLevel account,
picks the sub-account to grant, and is redirected back. Access tokens refresh automatically;
an agency-level grant can mint a sub-account token via `POST /oauth/locationToken`.

This second path needs a **HighLevel marketplace app** (a client id and secret) to exist once.
HighLevel does not support dynamic client registration, so there is no way for this server to
create one for you — the login page walks through the three-minute setup, and once anyone does
it the button is there for everybody. Set `GHL_OAUTH_CLIENT_ID` / `GHL_OAUTH_CLIENT_SECRET` in
the environment to provision it for a whole team at once.

**The login page is a loopback page**, so it only works where the browser and the server are on
the same machine: local Claude Code (terminal, desktop, IDE). In a cloud/web session there is no
such browser — set that account's token and location as environment variables there instead, the
way [`accounts.conf`](../accounts.conf) describes. The server reads those too (see below).

## What it enforces

| Rule | How |
|---|---|
| Never act on an account the user did not name | every data tool requires `account`; there is no default, and an empty one is refused with the list of aliases to ask about |
| Confirm anything outbound or destructive | `ghl_send_message`, `ghl_create_appointment`, `ghl_update_appointment`, `ghl_add_to_workflow`, `ghl_add_to_campaign`, `ghl_send_invoice`, `ghl_void_invoice`, every delete, and any non-GET `ghl_request` refuse to run without `confirm: true`, returning the exact request as a dry run first |
| Read before you write | update/delete tools `GET` the record and write a timestamped backup to `~/.ghl-mcp/backups/<alias>/` before changing it, and show what the old values were |
| Never print a token | tokens are fingerprinted (`pit-abc1… (36 chars)`); a regex scrub strips PITs, bearer headers, OAuth tokens and JWTs from every response, including HighLevel's error bodies |
| Don't create tags/fields as a side effect | `ghl_create_tag` and `ghl_create_custom_field` are confirmation-gated like a write to a customer |
| A 401/403 is a missing scope, not a retry | the error names the scope to add, says a new token will be issued, and the request is never retried |
| Respect the rate limit | a shared 90-requests / 10-seconds sliding window, and a single `Retry-After` backoff on a 429 — never retry-hammer |
| Never hardcode an opaque id | stage, field, calendar and workflow ids are only ever fetched — `ghl_list_pipelines`, `ghl_custom_fields`, `ghl_list_calendars`, `ghl_list_workflows` |

Every one of those rows is covered by a test in [`test/run.js`](test/run.js) — 65 in total,
run with `npm test --prefix mcp-server`, no credentials required.

## Multiple sub-accounts

Each login is saved under a short alias, and every tool takes `account: "<alias>"`. Existing
setups keep working unchanged: the server also reads [`accounts.conf`](../accounts.conf) and the
`GHL_PIT_TOKEN…`/`GHL_LOCATION_ID…` environment variables, shows those aliases in
`ghl_accounts` marked *not logged in* until their variables are set, and prefers a browser login
when both exist for the same alias. Resolution order:

1. browser login (`~/.ghl-mcp/credentials.json`)
2. `accounts.conf` row → its credentials, from the environment or the repo's `.env`
3. bare `GHL_PIT_TOKEN` / `GHL_LOCATION_ID`, likewise

The server reads the repo's `.env` itself (a real environment variable still wins), so an
existing setup works with **no relaunch** — unlike the `leadconnector` server, which only sees
the token if the session was started through the `claude-here` wrapper.

## Tools

`ghl_login` · `ghl_login_status` · `ghl_login_config` · `ghl_accounts` · `ghl_whoami` ·
`ghl_logout` — connect and inspect accounts.

`ghl_list_contacts` · `ghl_search_contacts` · `ghl_get_contact` · `ghl_export_contact` ·
`ghl_duplicate_check` · `ghl_create_contact` · `ghl_upsert_contact` · `ghl_update_contact` ·
`ghl_delete_contact` · `ghl_add_tags` · `ghl_remove_tags` · `ghl_contact_notes` ·
`ghl_add_note` · `ghl_update_note` · `ghl_delete_note` · `ghl_contact_tasks` · `ghl_add_task` ·
`ghl_complete_task` · `ghl_contact_appointments`

`ghl_list_conversations` · `ghl_get_conversation` · `ghl_conversation_messages` ·
`ghl_get_message` · `ghl_create_conversation` · `ghl_send_message` ·
`ghl_record_inbound_message` · `ghl_email_delivery_detail`

`ghl_list_pipelines` · `ghl_search_opportunities` · `ghl_get_opportunity` ·
`ghl_create_opportunity` · `ghl_update_opportunity` · `ghl_set_opportunity_status` ·
`ghl_delete_opportunity` · `ghl_opportunity_followers`

`ghl_list_calendars` · `ghl_get_calendar` · `ghl_free_slots` · `ghl_list_events` ·
`ghl_get_appointment` · `ghl_create_appointment` · `ghl_update_appointment` ·
`ghl_delete_event` · `ghl_block_slot` · `ghl_calendar_groups`

`ghl_list_workflows` · `ghl_add_to_workflow` · `ghl_remove_from_workflow` ·
`ghl_list_campaigns` · `ghl_add_to_campaign` · `ghl_remove_from_campaign`

`ghl_get_location` · `ghl_list_locations` · `ghl_custom_fields` · `ghl_create_custom_field` ·
`ghl_custom_values` · `ghl_set_custom_value` · `ghl_list_tags` · `ghl_create_tag` ·
`ghl_search_tasks` · `ghl_list_users` · `ghl_get_user` · `ghl_list_custom_menus` ·
`ghl_location_timezones` · `ghl_list_forms` · `ghl_form_submissions` · `ghl_list_surveys` ·
`ghl_survey_submissions`

`ghl_list_products` · `ghl_get_product` · `ghl_product_prices` · `ghl_list_invoices` ·
`ghl_get_invoice` · `ghl_send_invoice` · `ghl_void_invoice` · `ghl_record_invoice_payment` ·
`ghl_list_orders` · `ghl_get_order` · `ghl_list_transactions` · `ghl_list_subscriptions`

`ghl_list_funnels` · `ghl_list_funnel_pages` · `ghl_list_links` · `ghl_create_link` ·
`ghl_list_businesses` · `ghl_get_business` · `ghl_list_media` · `ghl_list_email_templates` ·
`ghl_list_blog_sites` · `ghl_list_blog_posts` · `ghl_list_social_posts` ·
`ghl_list_social_accounts`

`ghl_search_operations` · `ghl_describe_operation` · `ghl_request` — find any endpoint in the
catalogue, learn how to call it, then call it. This is how anything without a typed tool above
still gets done.

## Configuration

Everything has a working default; these exist for unusual setups.

| Variable | Default | What it does |
|---|---|---|
| `GHL_MCP_TOOLSET` | `full` | `core` trims 101 tools (~20k tokens of schema) to 35 (~7k); the rest stay reachable via `ghl_search_operations` + `ghl_request` |
| `GHL_MCP_HOME` | `~/.ghl-mcp` | where credentials and backups live |
| `GHL_MCP_BACKUP_DIR` | `$GHL_MCP_HOME/backups` | pre-write record backups |
| `GHL_OAUTH_CLIENT_ID` / `_SECRET` | — | provision the "log in with HighLevel" app for everyone |
| `GHL_MCP_LOGIN_PORT` | `0` (random) | pin the loopback port, so one OAuth redirect URL keeps working |
| `GHL_MCP_LOGIN_TTL_MS` | `900000` | how long a login link stays live |
| `GHL_MCP_RATE_MAX` / `_WINDOW_MS` | `90` / `10000` | request budget |
| `GHL_MCP_TIMEOUT_MS` | `60000` | per-request timeout |
| `GHL_API_BASE_URL` / `GHL_API_VERSION` | `https://services.leadconnectorhq.com` / `2021-07-28` | API target |
| `HTTPS_PROXY` / `NO_PROXY` | — | honoured via CONNECT tunnelling, for proxied environments |

## Layout

```
server.js            entry point: stdio MCP, --login, --list
src/mcp.js           JSON-RPC 2.0 / MCP over newline-delimited stdio
src/http.js          dependency-free HTTPS client with proxy support
src/api.js           API v2 client: mandatory headers, rate limit, scope-aware errors
src/config.js        paths and defaults
src/store.js         ~/.ghl-mcp/credentials.json, 0600
src/accounts.js      alias resolution: login store, then accounts.conf, then env vars
src/oauth.js         HighLevel OAuth: authorize, exchange, refresh, location token
src/login.js         the loopback login server
src/pages.js         the login pages (self-contained HTML)
src/safety.js        confirmation gates, backups, token redaction
src/catalog.js       167 API v2 operations, with the locationId convention for each
src/tools/           the tool definitions, by domain
test/run.js          65 self-tests against a stubbed HighLevel
```

## The hosted sibling

This server runs on one person's machine over stdio. [../remote/](../remote/) serves the **same
tool layer** over HTTPS as a remote MCP server, so someone who never opens this repository can
add a URL in Claude (web, desktop, mobile) or any other MCP client and authorise it with their
own HighLevel credentials. The tools, the safety gates and the endpoint catalogue are shared —
only the session tools and the credential source differ. See
[../remote/README.md](../remote/README.md) and [../PUBLISHING.md](../PUBLISHING.md).

Per-request credentials are bound through [src/context.js](src/context.js)
(AsyncLocalStorage), which is what lets one tool implementation serve one local user or many
concurrent hosted tenants without an ambient "current account" they could read from each other.

## Relationship to the rest of the repo

This server is **additive**. The `/ghl` skill's PowerShell and bash helpers still work exactly
as before for scripted and bulk work, `accounts.conf` still means what it meant, and HighLevel's
own `leadconnector` MCP is still registered in `.mcp.json` for anyone who wants it. What changes
is that a person can now be productive without a token existing anywhere on disk first.
