# The hosted connector

A **remote MCP server**: you deploy it once, and anyone can add its URL to Claude (web,
desktop, mobile), Cursor, or any other MCP client and authorise it with their **own**
GoHighLevel credentials. No Claude Code, no repository on their machine, no token to copy
around.

```
Person in Claude on their phone
        │  adds  https://ghl.example.com/mcp
        ▼
This server ──── OAuth 2.1 (it is its own authorization server) ──── consent screen
        │                                                                   │
        │                                              "Sign in with HighLevel" (their own login)
        │                                                                   ▼
        │                                              tick the sub-accounts they want ──┐
        │                                                                   ▲            │
        │                                        sign in to another CRM ────┘            │
        │                                                                                ▼
        └──── HighLevel API v2, one credential per sub-account ────── every one they chose
```

- **98 tools** (32 with `GHL_MCP_TOOLSET=core`) — the same tool layer as the local server, so
  there is one implementation of contacts, conversations, opportunities, calendars, workflows,
  commerce and content, plus `ghl_request` for anything else in the API.
- **Zero dependencies.** Plain Node ≥ 18. No `npm install`, no build — including the Redis
  backend, which speaks Upstash's HTTP API rather than a driver.
- **Multi-tenant and isolated.** Each connection carries its own encrypted credential, and a
  request can only ever see the sub-accounts its own token authorised.
- **Many sub-accounts, and more than one CRM.** One connection can hold every sub-account a
  person can reach, across **several HighLevel agencies** — they sign in once per agency and
  the sub-accounts accumulate. Two agencies with a client of the same name get two aliases
  that name the CRM (`bluebird-childcare-mvp`, `bluebird-childcare-kellix`), so nothing can
  quietly resolve to the wrong business.
- **The safety rules travel with it** — confirm-before-sending, read-before-writing, account
  must be named — because they live in the tool layer, not in a prompt on someone's laptop.

---

## Deploy it

Pick by what the platform gives you. The connector needs somewhere durable to keep OAuth
grants and encrypted credentials; that is the only thing that varies.

| Platform | Store | Notes |
|---|---|---|
| **Netlify** | Redis (required) | Filesystem is wiped between invocations. Add Upstash Redis from Netlify Extensions |
| **Vercel** | Redis (required) | Same, with Upstash Redis from the Vercel Marketplace |
| **Any VPS, Fly, Railway, Render, ECS** | Disk (default) | Mount a volume at `DATA_DIR` and there is nothing else to configure |
| **Local, for a look** | Disk | `node remote/server.js` and open `http://localhost:8787` |

Netlify and Vercel are the same deployment in two shapes, and both are already wired up:
[`netlify.toml`](../netlify.toml) + [`netlify/functions/connector.mjs`](../netlify/functions/connector.mjs),
or [`vercel.json`](../vercel.json) + [`api/index.js`](../api/index.js). Nothing to build on
either — the connector has no dependencies.

### Netlify

1. **Add the repository as a site** (Add new site → Import an existing project). Leave the
   base directory as the repository root: the function needs both `remote/` and `mcp-server/`
   in its bundle, so a site rooted at `remote/` would not work. `netlify.toml` already sets
   the publish and functions directories, and routes every path to the function — so the
   connector keeps its real URLs (`/mcp`, `/.well-known/…`, `/oauth/…`) rather than exposing
   `/.netlify/functions/` to clients. **Build command:** leave it as the file specifies; there
   is nothing to compile.
2. **Add Redis:** site → **Extensions** → search **Upstash** → install and create a database.
   It injects the REST URL and token, and the connector picks them up under any of the names
   Netlify or Upstash use. (Or create the database at upstash.com and set `REDIS_REST_URL` and
   `REDIS_REST_TOKEN` yourself.)
3. **Add the environment variables** (site → Site configuration → Environment variables):

   | Variable | Value |
   |---|---|
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` — **required here.** There is no disk to keep a generated key on, so without it every invocation would invent a different one and no stored connection could ever be read back |
   | `PUBLIC_URL` | Your final URL, e.g. `https://ghl.acme.com`. Optional at first — the site's own production address is used if you omit it — but set it before anyone connects, and before you register the HighLevel redirect URL |
   | `TRUST_PROXY` | `true`. Netlify terminates TLS in front of the function, so the caller's address only arrives as a header. Without this, rate limiting cannot tell two callers apart |
   | `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` | From the HighLevel marketplace app — see [PUBLISHING.md](../PUBLISHING.md). Without them nobody can sign in |

4. **Deploy**, then open `https://<your-site>/healthz`. It should report `"status":"ok"` and
   `"storage":"redis (…)"`. A `503` with `storageError` means the Redis details did not arrive.
5. Add `https://<your-site>/mcp` as a custom connector in Claude.

Then register the marketplace app per [PUBLISHING.md](../PUBLISHING.md); the redirect URL is
`https://<your-site>/highlevel/callback`.

Netlify specifics worth knowing:

- **Use the production URL, not a deploy preview.** Every branch and deploy preview gets its
  own hostname, but `PUBLIC_URL` is the OAuth issuer and the audience every access token is
  bound to, and HighLevel accepts exactly one registered redirect URL. Set it explicitly and
  connect through that domain only.
- **Functions are synchronous and capped** (26s on the free tier, 30s otherwise), which is
  ample: every endpoint here is one HighLevel call or less.
- **The legacy SSE transport is not available** — it needs a process that outlives the
  request. `/sse` returns a clear `501` pointing at `/mcp`, which is what current clients use.
- **How it works:** the connector stays a plain Node `(req, res)` handler; Netlify hands it
  Web `Request`/`Response`, so [`src/serverless.js`](src/serverless.js) adapts between the
  two. The test suite runs the entire connect flow through that adapter as well as over a real
  socket, so the two cannot quietly diverge.

### Vercel

Works, but **not with your Vercel account alone** — you also need a Redis store, which you
provision from inside Vercel. Serverless functions get a fresh, private filesystem on every
invocation, so anything written to disk is gone by the next request: grants, connections and
half-finished logins would all evaporate and every client would be disconnected within
minutes. `node remote/server.js --check` refuses to start in that configuration rather than
letting you discover it in production.

1. **Import the repository** into Vercel. Leave the root directory as the repository root —
   the function needs both `remote/` and `mcp-server/` in its bundle, so a project rooted at
   `remote/` would not build. [`vercel.json`](../vercel.json) and
   [`api/index.js`](../api/index.js) are already there; there is no build step.
2. **Add Redis:** project → **Storage** → **Marketplace** → **Upstash Redis** → create. Vercel
   injects the connection details as environment variables and the connector picks them up
   automatically, under any of the names Vercel or Upstash use.
3. **Add two environment variables** (project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` — **required here.** There is no disk to keep a generated key on, so without it every invocation would invent a different one and no stored connection could ever be read back |
   | `PUBLIC_URL` | Your final URL, e.g. `https://ghl.acme.com`. Optional at first — the project's production domain is used if you omit it — but set it before anyone connects, and before you register the HighLevel redirect URL |

4. **Deploy**, then open `https://<your-domain>/healthz`. It should report `"status":"ok"` and
   `"storage":"redis (…)"`. A `503` with `storageError` means the Redis details did not arrive.
5. Add `https://<your-domain>/mcp` as a custom connector in Claude.

Then follow [PUBLISHING.md](../PUBLISHING.md) to register the HighLevel marketplace app — it
is what makes "Sign in with HighLevel" work, and without it nobody can connect. The redirect
URL to register is `https://<your-domain>/highlevel/callback`.

Two things to know about Vercel specifically:

- **`PUBLIC_URL` must stop changing.** It is the OAuth issuer and the audience every access
  token is bound to, and HighLevel accepts exactly one registered redirect URL. Preview
  deployments get their own hostnames, so set `PUBLIC_URL` explicitly and connect through that
  domain only.
- **The legacy SSE transport is not available** — it needs a process that outlives the request.
  The endpoint returns a clear `501` pointing at `/mcp`, which is what current clients use
  anyway.

### Docker (any VPS, Fly, Railway, Render, ECS…)

```bash
cp remote/.env.example remote/.env      # set PUBLIC_URL and ENCRYPTION_KEY
openssl rand -hex 32                    # ← paste as ENCRYPTION_KEY
docker compose -f remote/docker-compose.yml up -d
docker compose -f remote/docker-compose.yml exec ghl-mcp node remote/server.js --check
```

That listens on `127.0.0.1:8787`. Put TLS in front of it — OAuth 2.1 requires HTTPS on every
authorization endpoint, and HighLevel refuses a non-HTTPS redirect URL. With Caddy that is two
lines:

```caddyfile
ghl.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### Without Docker

```bash
PUBLIC_URL=https://ghl.example.com ENCRYPTION_KEY=$(openssl rand -hex 32) \
  DATA_DIR=/var/lib/ghl-mcp node remote/server.js
```

A systemd unit, for a plain VPS:

```ini
[Unit]
Description=GoHighLevel MCP connector
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/ghl-claude-connector/remote/server.js
WorkingDirectory=/opt/ghl-claude-connector
EnvironmentFile=/etc/ghl-mcp.env
User=ghl-mcp
Restart=always
# The only path it needs to write is its data directory.
StateDirectory=ghl-mcp
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`node remote/server.js --check` validates the configuration and exits non-zero if something
would break at runtime — worth running in CI and after every config change.

---

## How someone connects

1. In their client, they add a custom connector / MCP server with the URL `PUBLIC_URL/mcp`.
2. The client discovers this server's OAuth endpoints, registers itself, and opens the consent
   screen in a browser.
3. That screen **names the client asking for access**, then: **Sign in with HighLevel** —
   their own email and password, on HighLevel's own site. This server never sees the password.
   (Needs the marketplace app — see [PUBLISHING.md](../PUBLISHING.md).)
4. **They tick the sub-accounts to share.** An agency login lists every sub-account that
   account covers, with **Add all N** for the whole lot. A login that covers exactly one
   sub-account skips this screen — a checklist of one is a question with a single answer.
5. **Finish** hands the authorization code back to the client. Nothing reaches the assistant
   before that: no code is issued until they finish, and finishing with nothing attached is
   refused.
6. Access tokens refresh silently, and so does each HighLevel credential.

**Someone who works across two HighLevel agencies** signs in again from the review screen and
that CRM's sub-accounts join the same connection rather than replacing it — repeatable as many
times as needed. That option is deliberately quiet: most people have one HighLevel account and
being asked about a second makes a finished connection look unfinished, so **Finish** is the
only thing presented and the second-CRM option sits behind a collapsed disclosure. Once
someone has added two CRMs they have shown that is how they work, and it stays open for them.

Then, in the conversation, `ghl_accounts` lists what the connection can reach — grouped by
CRM — and every other tool requires the alias. There is no default: a request that does not
name a sub-account is refused rather than guessed at.

Nothing is typed into a conversation, and nothing is stored in this repository.

### One sub-account, many credentials

Each sub-account someone attaches becomes its own connection record with its own credential.
Two people who both authorise the same sub-account get two separate records — so one person
revoking, or their HighLevel access being removed, cannot break the other, and every call is
attributable to the person whose login made it.

### The Private Integration Token route

There is a second way in — pasting a `pit-…` token — and it is **off by default**
(`ALLOW_TOKEN_CONNECT=false`). It exists for operating the connector before the marketplace
app is registered, and for a sub-account whose owner would rather issue a scoped token than
sign in. An agency-level token gets the same sub-account checklist. Turn it on only if you
want it: with it off, the only way to connect is a person's own HighLevel login.

---

## Security properties

These are tested, not aspirational — see [test/run.js](test/run.js) (83 tests: the multi-CRM
flow, and every property below re-checked through the serverless adapter) and
[test/storage.js](test/storage.js) (31, both storage backends).

**As an OAuth 2.1 authorization server**

| Property | How |
|---|---|
| PKCE required | `code_challenge_method=S256` only; a missing or `plain` challenge is refused |
| Exact redirect matching | Registered URIs are compared whole; an unregistered URI is never redirected to, so this cannot be used as an open redirector |
| HTTPS redirects only | Except loopback and native custom schemes, which OAuth 2.1 permits |
| Public clients only | `token_endpoint_auth_method: none`; no client secret is ever minted, so none can leak |
| Single-use codes | Deleted before validation, so a replay always fails even under a race |
| Rotating refresh tokens | Every refresh issues a new one, and **replaying a retired one revokes the whole grant** — a stolen token becomes detectable rather than quietly useful |
| Audience binding (RFC 8707) | Tokens are issued for `PUBLIC_URL/mcp` and validated against it; a token minted for another resource is rejected |
| No token passthrough | The client's token is never forwarded to HighLevel. The HighLevel credential is separate and never leaves this server |
| Consent per client | A dynamically registered client cannot inherit an earlier grant: connecting *is* consenting, and the screen names the client |
| Rate limited | Per IP on the OAuth endpoints, per connection on `/mcp` |
| Indexes are hints, not authority | A token lookup index can outlive what it pointed at, so the grant itself is always re-checked — a rotated-away token cannot authenticate on a stale index entry |
| Nothing granted before Finish | A sign-in and a sub-account pick change only server-side login state; the authorization code exists only after the person finishes, and an empty connection is refused |
| A picker cannot be replayed across CRMs | Signing in to a second agency clears the first one's pending checklist, and HighLevel refuses to mint a token for a sub-account outside the agency that was signed into |
| Aliases are per grant | Aliases are computed from the tenants one grant references and qualified by CRM when names collide, so an alias belonging to another connection simply does not exist |

**Storing credentials**

- GoHighLevel credentials are sealed with **AES-256-GCM** before they touch disk.
- Issued access and refresh tokens are stored as **SHA-256 digests only** — a stolen data file
  cannot be replayed.
- Data files are written `0600` into `DATA_DIR`, atomically.
- **One connection, one credential.** Two people who authorise the same sub-account get two
  separate records; nobody's calls ever run under someone else's token, and one person
  revoking cannot break the other.
- Tokens are fingerprinted (`pit-abc1… (36 chars)`), never printed, and scrubbed from every
  response including HighLevel's error bodies.
- Logs carry request shapes and outcomes — never bodies, tokens or CRM data.

**Pages**

Self-contained HTML with a strict CSP (`default-src 'none'; form-action 'self'`),
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and no external asset of any kind, so
a credential typed on the consent screen has nowhere to leak to.

---

## Endpoints

| Path | What |
|---|---|
| `GET /` | landing page, explains the connector to a human |
| `GET /healthz` | liveness/readiness, safe to expose |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 (also served with a path suffix) |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 (also `/.well-known/openid-configuration`) |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET /oauth/authorize` | consent + connect screen |
| `POST /oauth/token` | code exchange and refresh |
| `POST /oauth/revoke` | RFC 7009 |
| `POST /oauth/connect/highlevel` | start (or repeat, per CRM) the HighLevel sign-in |
| `GET /highlevel/callback` | where HighLevel's OAuth returns |
| `POST /oauth/connect/select` | attach the ticked sub-accounts from the CRM just signed into |
| `POST /oauth/connect/finish` | done adding CRMs — the only step that returns a code |
| `POST /oauth/connect/token` | the Private Integration Token route (off unless `ALLOW_TOKEN_CONNECT`) |
| `POST /mcp` | MCP, Streamable HTTP — **this is the URL people add** |
| `GET /sse` + `POST /messages` | MCP, legacy SSE, for older clients |

---

## Configuration

Full list with comments in [.env.example](.env.example). The two that matter:

| Variable | Why it matters |
|---|---|
| `PUBLIC_URL` | The OAuth issuer and the token audience. Wrong value = discovery hands clients endpoints that do not work |
| `ENCRYPTION_KEY` | Losing or changing it makes every stored connection unreadable and everyone must reconnect. Generate with `openssl rand -hex 32` and keep a copy |
| `STORAGE` | `file` (default) needs a persistent disk; `redis` is required on anything serverless. `auto` picks Redis when connection details are present |
| `REDIS_REST_URL` / `REDIS_REST_TOKEN` | Upstash REST credentials. Vercel's integration injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` instead, and those are read too — nothing to rename |

Worth knowing:

- `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` are what make "Sign in with HighLevel" work, and are
  therefore **required** unless you deliberately turn the token route on. `node server.js
  --check` fails when neither route is available, rather than deploying a connector nobody
  can connect to.
- `ALLOW_TOKEN_CONNECT=true` re-enables pasting a Private Integration Token on the consent
  screen. Default `false`.
- `SIGNUP_PASSCODE` gates who may connect at all — use it for a connector meant only for your
  own team or clients rather than the public.
- `ALLOWED_REDIRECT_HOSTS` narrows which clients can be used at all (e.g. `claude.ai`).
- `TRUST_PROXY=true` is needed behind any TLS terminator — a platform router, Caddy, nginx —
  or rate limiting sees one address for everybody. Set it on Netlify and Vercel.
- `GHL_MCP_TOOLSET=core` trims 98 tools to 32 when tool-schema size matters to the client.

---

## Operating it

- **Back up `DATA_DIR`** and store `ENCRYPTION_KEY` somewhere separate. Together they are
  every connection; separately, neither is much use.
- **Replicas need a shared store.** On the file backend that means one instance, or a shared
  `DATA_DIR`; on Redis they can scale freely. Everything goes through
  [src/storage/](src/storage/), so adding a Postgres backend is one new file implementing the
  same interface — nothing above it would change.
- **On Redis, expiry is a TTL** and there is nothing to sweep. Authorization codes are also
  redeemed with `GETDEL`, so single use is atomic even when two instances race for the same
  code — which is exactly the situation serverless creates.
- **`/healthz`** is what a platform should probe.
- **`--check`** after any config change.
- Rate-limit state is per instance and in memory, so several replicas each get their own
  window. That is fine for the abuse it blunts.

## Layout

```
server.js               entry point; --check validates configuration
src/config.js           configuration and the boot-time audit
src/app.js              the HTTP router
src/transport.js        MCP over Streamable HTTP and legacy SSE
src/instructions.js     what the assistant is told about these tools and rules
src/tenants.js          connections: encrypted credentials + the tool layer's provider
src/storage/index.js    backend selection (file | redis | auto) and the storage interface
src/storage/file.js     atomic JSON files, for a disk
src/storage/redis.js    Upstash REST, for serverless and replicas — still zero dependencies
src/crypto.js           AES-256-GCM, digests, PKCE verification
src/ratelimit.js        fixed-window limits
src/serverless.js       Web Request/Response adapter, for Netlify-style platforms
src/pages.js            consent, sub-account picker, review, connected and landing pages
src/oauth/metadata.js   RFC 9728 + RFC 8414 discovery documents
src/oauth/clients.js    RFC 7591 dynamic client registration
src/oauth/tokens.js     codes, access/refresh tokens, rotation and reuse detection
src/oauth/authorize.js  the authorize endpoint and the connect flow
test/run.js             83 self-tests against a real HTTP server, HighLevel stubbed —
                        including the whole flow re-run through the serverless adapter
test/storage.js         31 self-tests: both backends against one contract, plus the whole
                        OAuth flow on Redis against a fake Upstash
```

The tool layer itself lives in [../mcp-server/src](../mcp-server/src) and is shared with the
local stdio server. Per-request credentials are bound through
[`context.js`](../mcp-server/src/context.js) (AsyncLocalStorage), which is what makes one tool
implementation safe to serve many tenants at once.
