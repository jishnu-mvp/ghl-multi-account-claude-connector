---
name: ghl
description: Work with a GoHighLevel / HighLevel (LeadConnector) sub-account via its API v2 from Claude Code, authenticated with a Private Integration Token. Use for contacts, conversations & messaging, opportunities & pipelines, calendars & appointments, forms, surveys, custom fields, tags, users, workflows, campaigns, products, invoices, payments, media and every other v2 endpoint — anything the LeadConnector MCP can't do or shouldn't. Includes the full endpoint reference, the scope→endpoint map, and ready helper scripts (PowerShell + bash). Trigger with /ghl or whenever a GoHighLevel operation is needed.
---

# GoHighLevel API v2 skill (Private Integration Token)

Use this when you need to talk to HighLevel **programmatically**. For conversational
"find this customer / book them in" flows the LeadConnector MCP is fine — but for everything
else, and whenever an MCP tool is missing/restricted/erroring, use the API described here.

## 0. Decision recap (API vs MCP)

Prefer the **API** for: bulk ops, exports/backups, precise field-level edits, custom fields
and custom values, forms/surveys submissions, workflow & campaign membership, products,
invoices, payments, media, blogs, funnels, users, CI, reproducible runs, anything scripted.
Prefer the **MCP** for: conversational lookup ("find the contact for jane@x.com"), quick
one-off reads mid-chat, and discovering an operation's input shape via `search_operations` /
`describe_operation`. When in doubt → **API** (it's the superset).
Full table is in [CLAUDE.md](../../../CLAUDE.md).

## 1. Connection

Everything comes from `.env` at the repo root:

```
GHL_PIT_TOKEN=pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
GHL_LOCATION_ID=<sub-account id>
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
```

Every API v2 request needs **three** headers — missing `Version` is the single most common
cause of a confusing 4xx:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <GHL_PIT_TOKEN>` |
| `Version` | `2021-07-28` (a few legacy endpoints want `2021-04-15`) |
| `Content-Type` | `application/json` (on writes) |

- **Base URL:** `https://services.leadconnectorhq.com` — no `/v1` or `/v2` path segment; the
  resource path follows the host directly (`/contacts/`, `/opportunities/search`, …).
- **`locationId` is not implicit.** Most endpoints need it as a query param, a body field, or
  a path segment. The helper scripts inject `GHL_LOCATION_ID` for you. Note the casing traps:
  `/contacts/?locationId=` but `/opportunities/search?location_id=`, and
  `?altId=<location>&altType=location` for invoices/payments/media.
- If `.env` is missing, tell the user to `cp .env.example .env` and add their token. **Never
  print the token value** — the helper's `whoami` deliberately shows only a prefix.

### Getting the token (once)
HighLevel → **Settings → Other Settings → Private Integrations → Create new Integration** →
name it, **tick the scopes** → copy the token. It is shown **once** and cannot be retrieved
later; if lost, create a new integration. Token strings start with `pit-`.

## 2. Use the helper scripts (don't hand-roll curl)

**Windows / PowerShell:**
```powershell
.\.claude\skills\ghl\scripts\ghl.ps1 [-Account <alias>] <command> [args]
```
**macOS / Linux / Git-Bash:**
```bash
./.claude/skills/ghl/scripts/ghl.sh [--account <alias>] <command> [args]
```

### Multiple sub-accounts

[accounts.conf](../../../accounts.conf) at the repo root lists every sub-account this
connector knows about (alias, display name, and which env vars hold its token/location — no
secrets in that file, it's safe to read and commit). Omit `--account`/`-Account` to use the
default sub-account (the row whose token env var is `GHL_PIT_TOKEN`); name any other alias to
target a different sub-account, in the same session, no relaunch needed:
```bash
./.claude/skills/ghl/scripts/ghl.sh --account clienta list-contacts
```
**Never call any GHL operation — read or write — unless the user's request named the account.**
No name, no call: ask which account first instead of defaulting to any one of them, even if only
one is currently registered. When you do act, state the account's display name (from
`accounts.conf`) back in the response. Mixing up two clients' CRMs is exactly the kind of
mistake the confirm-before-write rules in [CLAUDE.md](../../../CLAUDE.md) exist to prevent.

Adding a new sub-account is: create a Private Integration in that HighLevel sub-account, add its
token + Location ID as two new env vars with a unique suffix, add a row to `accounts.conf`
mapping an alias to those two var names. No code changes, no new environment, no new chat.

The LeadConnector MCP (`leadconnector` in `.mcp.json`) is wired to the **default** sub-account
only — for any other account, use the API via `--account`/`-Account` as above.

Both load `.env`, attach all three headers, inject `locationId`, pretty-print JSON, and print
HighLevel's error body verbatim on failure (which is what names a missing scope). Run with no
arguments for the command list. Any command taking `<file|json>` accepts **either** a path to
a `.json` file **or** inline JSON.

Start with `whoami` — it prints the resolved config and probes `GET /locations/{id}`, which is
the fastest way to prove the token + location + scopes work.

| Command | What it does | REST call |
|---|---|---|
| `whoami` | Show resolved config + probe the location | `GET /locations/{locationId}` |
| `get-location` | Sub-account details | `GET /locations/{locationId}` |
| `list-locations` | Sub-accounts (**agency-level token only**) | `GET /locations/search` |
| **Contacts** | | |
| `list-contacts [query]` | List/search contacts | `GET /contacts/?locationId=` |
| `get-contact <id>` | Full contact | `GET /contacts/{id}` |
| `export-contact <id> [file]` | Save contact JSON to a file (backup) | `GET /contacts/{id}` |
| `search-contacts <file\|json>` | Filtered/sorted search | `POST /contacts/search` |
| `create-contact <file\|json>` | Create (body needs `locationId`) | `POST /contacts/` |
| `upsert-contact <file\|json>` | Create-or-update by email/phone | `POST /contacts/upsert` |
| `update-contact <id> <file\|json>` | Update (body must **not** include `locationId`) | `PUT /contacts/{id}` |
| `delete-contact <id>` | Delete | `DELETE /contacts/{id}` |
| `duplicate-check <email>` | Find an existing contact by email | `GET /contacts/search/duplicate` |
| `add-tags <id> <a,b>` | Add tags | `POST /contacts/{id}/tags` |
| `remove-tags <id> <a,b>` | Remove tags | `DELETE /contacts/{id}/tags` |
| `contact-notes <id>` / `add-note <id> <text>` | Notes | `GET`/`POST /contacts/{id}/notes` |
| `contact-tasks <id>` / `add-task <id> <file\|json>` | Tasks | `GET`/`POST /contacts/{id}/tasks` |
| `contact-appointments <id>` | Their appointments | `GET /contacts/{id}/appointments` |
| **Automation** | | |
| `list-workflows` | Workflows in the sub-account | `GET /workflows/?locationId=` |
| `add-to-workflow <cId> <wId>` | Enrol a contact | `POST /contacts/{cId}/workflow/{wId}` |
| `remove-from-workflow <cId> <wId>` | Remove | `DELETE /contacts/{cId}/workflow/{wId}` |
| `list-campaigns` | Campaigns | `GET /campaigns/?locationId=` |
| `add-to-campaign <cId> <campId>` | Add to campaign | `POST /contacts/{cId}/campaigns/{campId}` |
| `remove-from-campaign <cId> <campId>` | Remove | `DELETE /contacts/{cId}/campaigns/{campId}` |
| **Conversations** | | |
| `list-conversations [contactId]` | Search conversations | `GET /conversations/search` |
| `get-conversation <id>` | One conversation | `GET /conversations/{id}` |
| `create-conversation <file\|json>` | Start one | `POST /conversations/` |
| `messages <convId>` | Message history | `GET /conversations/{convId}/messages` |
| `get-message <msgId>` | One message | `GET /conversations/messages/{msgId}` |
| `send-message <file\|json>` | **Sends a real SMS/email** | `POST /conversations/messages` |
| **Opportunities** | | |
| `list-pipelines` | Pipelines + stage ids | `GET /opportunities/pipelines?locationId=` |
| `search-opportunities [pipelineId]` | Search | `GET /opportunities/search?location_id=` |
| `get-opportunity <id>` | One opportunity | `GET /opportunities/{id}` |
| `create-opportunity <file\|json>` | Create | `POST /opportunities/` |
| `update-opportunity <id> <file\|json>` | Update | `PUT /opportunities/{id}` |
| `set-opportunity-status <id> <status>` | open\|won\|lost\|abandoned | `PUT /opportunities/{id}/status` |
| `delete-opportunity <id>` | Delete | `DELETE /opportunities/{id}` |
| **Calendars** | | |
| `list-calendars` / `get-calendar <id>` | Calendars | `GET /calendars/` |
| `free-slots <calId> <startMs> <endMs>` | Bookable slots (epoch **ms**) | `GET /calendars/{calId}/free-slots` |
| `list-events <startMs> <endMs> [calId]` | Events in a window | `GET /calendars/events` |
| `get-appointment <eventId>` | One appointment | `GET /calendars/events/appointments/{id}` |
| `create-appointment <file\|json>` | **Books a real slot** | `POST /calendars/events/appointments` |
| `update-appointment <eventId> <file\|json>` | Reschedule/update | `PUT /calendars/events/appointments/{id}` |
| `delete-event <eventId>` | Cancel/delete | `DELETE /calendars/events/{id}` |
| **Forms & surveys** | | |
| `list-forms` / `form-submissions [formId]` | Forms + submissions | `GET /forms/`, `/forms/submissions` |
| `list-surveys` / `survey-submissions [id]` | Surveys + submissions | `GET /surveys/`, `/surveys/submissions` |
| **Location config** | | |
| `custom-fields` | Custom field definitions + ids | `GET /locations/{id}/customFields` |
| `custom-values` | Custom values | `GET /locations/{id}/customValues` |
| `list-tags` | Tag vocabulary | `GET /locations/{id}/tags` |
| `list-users` | Users/staff | `GET /users/?locationId=` |
| `list-custom-menus` | Custom menu links | `GET /custom-menus/` |
| **Commerce** | | |
| `list-products` / `product-prices <id>` | Products + prices | `GET /products/`, `/products/{id}/price` |
| `list-invoices` | Invoices | `GET /invoices/?altId=&altType=location` |
| `list-orders` / `list-transactions` / `list-subscriptions` | Payments | `GET /payments/*` |
| **Content** | | |
| `list-funnels` / `list-links` / `list-businesses` | | `GET /funnels/funnel/list`, `/links/`, `/businesses/` |
| `list-media` | Media library | `GET /medias/files?altId=&altType=location` |
| `list-email-templates` | Email builder templates | `GET /emails/builder?locationId=` |
| `list-blog-sites` / `list-social-posts` | Blogs / social planner | `GET /blogs/site/all`, `POST /social-media-posting/{loc}/posts/list` |
| **Escape hatch** | | |
| `raw <METHOD> <path> [file\|json]` | Any endpoint, full control | any |

Example edit loop (read → back up → change → verify):
```bash
./.claude/skills/ghl/scripts/ghl.sh export-contact abc123 backup.json     # 1. back up
./.claude/skills/ghl/scripts/ghl.sh update-contact abc123 '{"tags":["vip"]}'  # 2. change
./.claude/skills/ghl/scripts/ghl.sh get-contact abc123                    # 3. verify
```

Example move an opportunity to a new stage:
```bash
./.claude/skills/ghl/scripts/ghl.sh list-pipelines                        # get stage ids
./.claude/skills/ghl/scripts/ghl.sh update-opportunity opp_1 '{"pipelineStageId":"stage_2"}'
```

## 3. Full endpoint reference

Base = `https://services.leadconnectorhq.com`. All require `Authorization: Bearer <PIT>` and
`Version: 2021-07-28`.

> The definitive, always-current reference is HighLevel's API explorer at
> <https://marketplace.gohighlevel.com/docs/> (or <https://highlevel.stoplight.io>). If an exact
> request body matters, confirm it there — or ask the MCP's `describe_operation` tool, which
> returns the live input schema for any operation. Do not invent field names.

### Contacts
- `GET    /contacts/?locationId=&limit=&query=&startAfterId=&startAfter` — list/search.
- `POST   /contacts/search` — body `{locationId, page, pageLimit, filters[], sort[]}`. The real
  search surface: filter by tag, custom field, date, dnd, etc.
- `GET    /contacts/{contactId}` — get one.
- `POST   /contacts/` — create. Body `{locationId, firstName, lastName, email, phone, tags[], customFields[], source}`.
- `POST   /contacts/upsert` — create-or-update matched on email/phone.
- `PUT    /contacts/{contactId}` — update. **Do not send `locationId`** in the body (400).
- `DELETE /contacts/{contactId}` — delete.
- `GET    /contacts/search/duplicate?locationId=&email=|phone=` — duplicate lookup.
- `POST   /contacts/{contactId}/tags` · `DELETE /contacts/{contactId}/tags` — body `{tags:[…]}`.
- `GET|POST /contacts/{contactId}/notes` · `GET|PUT|DELETE /contacts/{contactId}/notes/{noteId}`.
- `GET|POST /contacts/{contactId}/tasks` · `GET|PUT|DELETE /contacts/{contactId}/tasks/{taskId}`
  · `PUT /contacts/{contactId}/tasks/{taskId}/completed`.
- `GET    /contacts/{contactId}/appointments` — their appointments.
- `POST|DELETE /contacts/{contactId}/workflow/{workflowId}` — workflow membership.
- `POST|DELETE /contacts/{contactId}/campaigns/{campaignId}` ·
  `DELETE /contacts/{contactId}/campaigns/removeAll`.
- `POST   /contacts/bulk/business` — bulk-assign contacts to a business.

### Conversations & messaging
- `GET    /conversations/search?locationId=&contactId=&query=&status=&limit=` — search.
- `GET    /conversations/{conversationId}` · `POST /conversations/` · `PUT`/`DELETE /conversations/{id}`.
- `GET    /conversations/{conversationId}/messages?limit=&lastMessageId=` — history.
- `GET    /conversations/messages/{messageId}` — one message.
- `POST   /conversations/messages` — **send**. Body `{type:'SMS'|'Email'|'WhatsApp'|'IG'|'FB'|'Live_Chat', contactId, message, subject?, html?, attachments?[], emailFrom?}`.
- `POST   /conversations/messages/inbound` — record an inbound message (no send).
- `PUT    /conversations/messages/{messageId}/status` — update delivery status.
- `POST   /conversations/messages/upload` — upload attachments.
- `GET    /conversations/providers/email/{messageId}` — email delivery detail.

### Opportunities & pipelines
- `GET    /opportunities/pipelines?locationId=` — pipelines **and their stage ids** (fetch this
  before creating/moving an opportunity; stage ids are not guessable).
- `GET    /opportunities/search?location_id=&pipeline_id=&pipeline_stage_id=&status=&contact_id=&q=&limit=`
  — note the **snake_case** query params on this one endpoint.
- `GET    /opportunities/{id}` · `POST /opportunities/` · `PUT /opportunities/{id}` · `DELETE /opportunities/{id}`.
- `PUT    /opportunities/{id}/status` — body `{status:'open'|'won'|'lost'|'abandoned'}`.
- `PUT    /opportunities/{id}` also moves stages via `{pipelineStageId}`.
- `POST|DELETE /opportunities/{id}/followers` — assign followers.

### Calendars & appointments
- `GET    /calendars/?locationId=&groupId=&showDrafted=` · `GET /calendars/{calendarId}`
  · `POST /calendars/` · `PUT`/`DELETE /calendars/{calendarId}`.
- `GET    /calendars/{calendarId}/free-slots?startDate=&endDate=&timezone=&userId=` —
  **epoch milliseconds**, not ISO strings.
- `GET    /calendars/events?locationId=&calendarId=&groupId=&userId=&startTime=&endTime=` — events.
- `GET    /calendars/events/appointments/{eventId}` · `POST /calendars/events/appointments`
  · `PUT /calendars/events/appointments/{eventId}` · `DELETE /calendars/events/{eventId}`.
- `POST   /calendars/events/block-slots` · `PUT /calendars/events/block-slots/{eventId}` — blocks.
- `GET|POST /calendars/groups` · `GET /calendars/{calendarId}/notifications`.
- Appointment create body: `{calendarId, locationId, contactId, startTime, endTime?, title?, appointmentStatus?, assignedUserId?, address?, ignoreFreeSlotValidation?}`.

### Forms & surveys
- `GET /forms/?locationId=&limit=&skip=` · `GET /forms/submissions?locationId=&formId=&page=&limit=&startAt=&endAt=`.
- `POST /forms/upload-custom-files` — file-upload fields.
- `GET /surveys/?locationId=` · `GET /surveys/submissions?locationId=&surveyId=&page=&limit=`.

### Location (sub-account) configuration
- `GET    /locations/{locationId}` · `PUT /locations/{locationId}`.
- `GET    /locations/search?companyId=&limit=&skip=` — list sub-accounts (**agency token**).
- `POST   /locations/` — create a sub-account (**agency token**).
- `GET|POST /locations/{locationId}/customFields` · `GET|PUT|DELETE /locations/{locationId}/customFields/{id}`.
- `GET|POST /locations/{locationId}/customValues` · `GET|PUT|DELETE /locations/{locationId}/customValues/{id}`.
- `GET|POST /locations/{locationId}/tags` · `GET|PUT|DELETE /locations/{locationId}/tags/{tagId}`.
- `POST   /locations/{locationId}/tasks/search` — search tasks across the sub-account.
- `GET    /locations/{locationId}/timezones` · `GET /locations/{locationId}/templates`.

### Users
- `GET /users/?locationId=` · `GET /users/{userId}` · `POST /users/` · `PUT`/`DELETE /users/{userId}`
  · `GET /users/search?companyId=&query=`.

### Workflows & campaigns
- `GET /workflows/?locationId=` — list workflows (read-only; the API cannot author workflows —
  building them stays a UI job).
- `GET /campaigns/?locationId=&status=` — list campaigns.

### Commerce (products, invoices, payments)
- `GET|POST /products/` · `GET|PUT|DELETE /products/{productId}` · `GET|POST /products/{productId}/price`
  · `GET|PUT|DELETE /products/{productId}/price/{priceId}`.
- `GET|POST /invoices/?altId=<locationId>&altType=location` · `GET|PUT|DELETE /invoices/{invoiceId}`
  · `POST /invoices/{invoiceId}/send` · `POST /invoices/{invoiceId}/void`
  · `POST /invoices/{invoiceId}/record-payment` · `GET|POST /invoices/template` · `/invoices/schedule`.
- `GET /payments/orders?altId=&altType=location` · `GET /payments/orders/{orderId}`
  · `GET /payments/transactions` · `GET /payments/subscriptions`
  · `GET|POST /payments/integrations/provider/whitelabel`.
- `GET|POST /payments/custom-provider/provider` — custom payment providers.

### Content & assets
- `GET /funnels/funnel/list?locationId=` · `GET /funnels/page?locationId=&funnelId=`.
- `GET|POST /links/?locationId=` · `PUT`/`DELETE /links/{linkId}` — trigger links.
- `GET|POST /businesses/?locationId=` · `GET|PUT|DELETE /businesses/{businessId}`.
- `GET /medias/files?altId=&altType=location&sortBy=&sortOrder=` · `POST /medias/upload-file`
  · `DELETE /medias/{fileId}`.
- `GET /emails/builder?locationId=` · `POST /emails/builder` · `DELETE /emails/builder/{locationId}/{templateId}`.
- `GET /blogs/site/all?locationId=` · `GET /blogs/posts/all?locationId=&blogId=`
  · `POST|PUT /blogs/posts` · `GET /blogs/authors` · `GET /blogs/categories`.
- `POST /social-media-posting/{locationId}/posts/list` · `POST|PUT|DELETE /social-media-posting/{locationId}/posts/{postId}`
  · `GET /social-media-posting/{locationId}/accounts`.
- `GET /courses/…`, `GET /custom-menus/?locationId=`, `GET /objects/…` (custom objects),
  `GET /associations/…` (record associations) — same auth pattern; check the explorer for shapes.

### Agency / SaaS (mostly NOT available to a sub-account PIT)
- `GET /snapshots/?companyId=` · `POST /snapshots/snapshot-share/link` — snapshots.
- `GET|POST /saas-api/…` — SaaS mode subscription management.
- `GET /oauth/installedLocations`, `POST /oauth/locationToken` — OAuth-app-only.
- These need an **agency-level** Private Integration or a full OAuth marketplace app. A
  sub-account PIT returns 401/403 — that is expected, not a bug. Say so rather than retrying.

> **Pagination.** There is no single convention. Contacts use `limit` + `startAfter`/
> `startAfterId`; `POST /contacts/search` uses `page`/`pageLimit`; opportunities use
> `limit` + `startAfterId`; invoices/media use `limit`/`offset` or `limit`/`skip`. Read the
> response envelope (`meta`, `total`, `traceId`) instead of assuming.

## 4. Scopes: the #1 cause of 4xx

A Private Integration only has the scopes ticked when it was created. A missing scope returns
**401/403 with a message naming it** — the helper prints that body verbatim. Common mapping:

| You want to… | Scope(s) to tick |
|---|---|
| Read/write contacts, tags, notes, tasks | `contacts.readonly`, `contacts.write` |
| Read/send messages | `conversations.readonly`, `conversations.write`, `conversations/message.readonly`, `conversations/message.write` |
| Opportunities & pipelines | `opportunities.readonly`, `opportunities.write` |
| Calendars, slots, appointments | `calendars.readonly`, `calendars.write`, `calendars/events.readonly`, `calendars/events.write` |
| Custom fields / values / tags | `locations/customFields.*`, `locations/customValues.*`, `locations/tags.*` |
| Sub-account details | `locations.readonly` |
| Users | `users.readonly`, `users.write` |
| Workflows / campaigns | `workflows.readonly`, `campaigns.readonly` |
| Forms / surveys submissions | `forms.readonly`, `surveys.readonly` |
| Products / invoices / payments | `products.*`, `invoices.*`, `payments/orders.readonly`, `payments/transactions.readonly` |
| Media / links / businesses / blogs / social | `medias.*`, `links.*`, `businesses.*`, `blogs.*`, `socialplanner/*` |

**When a call 401/403s: do not retry, and do not fall back to a different endpoint hoping it
works.** Report the exact scope the user must add. Adding scopes issues a **new token** — the
old one keeps its old scopes, so `.env` must be updated too.

## 5. Safety checklist (enforced by CLAUDE.md)

- **Read before you write.** `get-contact` / `get-opportunity` before any `update-*`.
- **Back up before destructive ops.** `export-contact` (or `raw GET` → file) before update/delete.
- **Never send messages or book appointments without explicit user confirmation** —
  `send-message`, `create-appointment`, `add-to-workflow` and `add-to-campaign` all cause a real
  human to be contacted. There is no undo.
- **Never print or commit** `GHL_PIT_TOKEN`, or raw contact/conversation payloads — they are PII.
- **Never bulk-mutate** (loop over contacts writing) without an explicit, counted go-ahead.
- **Respect rate limits.** HighLevel's documented API v2 budget is roughly **100 requests per
  10 seconds** and **200,000 per day** per app/location; a 429 means back off and batch, not
  retry-hammer. Verify current limits in the docs before designing a big sync.
- After a change, **re-read the record** rather than trusting the write response.

## 6. When the API isn't enough

- **Authoring a workflow / funnel / email design:** not exposed by the API. Do it in the
  HighLevel UI; the API can only enrol contacts and read the list.
- **Triggering an automation:** there is no "run workflow now" endpoint. Use
  `add-to-workflow`, or an Inbound Webhook trigger inside the workflow and POST to its URL.
- **Discovering an exact request shape:** ask the MCP's `search_operations` /
  `describe_operation` tools, or open the API explorer. Cheaper than guessing and getting a 422.
- **Agency-wide operations:** need an agency-level PIT or an OAuth marketplace app — tell the
  user, don't work around it.
