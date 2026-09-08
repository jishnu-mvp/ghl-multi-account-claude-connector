# Publishing the connector as a HighLevel marketplace app

The hosted connector in [remote/](remote/) signs people in with **their own HighLevel email
and password** — they never paste a token, and they choose which sub-accounts to share, across
as many HighLevel agencies as they work with. That is what a **HighLevel marketplace app**
makes possible, and this document is how to create one.

**This step is required, not optional.** HighLevel has no dynamic client registration, so the
app has to be registered once, by you, as your agency. Until it is, the connector has no way
for anyone to sign in: `node remote/server.js --check` says so and refuses to call the
configuration ready. (There is a fallback for testing before then — `ALLOW_TOKEN_CONNECT=true`
re-enables pasting a Private Integration Token — but it is off by default and is not the
experience you want people to have.)

There are two levels, and you probably want them in this order:

| | **Private app** | **Public app** |
|---|---|---|
| Listed in the HighLevel marketplace | No | Yes |
| Who can install it | You and sub-accounts you give the install link to | Anyone |
| Review by HighLevel | None — usable immediately | Yes, with a demo video |
| Time to working | About five minutes | Depends on HighLevel's review queue |
| Enables "Sign in with HighLevel" | Yes | Yes |

**Start with a private app.** It gives you the entire sign-in experience for your own agency
and clients, needs no approval, and the credentials it produces are exactly what a public app
would produce. Go public only when you want strangers installing it.

> **One thing only you can do.** Creating the app requires signing in to the HighLevel
> marketplace as your agency — it is your app identity, your client secret, and your name on
> the listing. Everything else (the server, the OAuth implementation, the redirect handling,
> the token refresh, the tests) is already built and pushed. The steps below are the part that
> needs your HighLevel login.

---

## Before you start

You need:

1. **The connector deployed and reachable over HTTPS.** HighLevel requires the redirect URL to
   use HTTPS — a `http://localhost` redirect is not accepted — so the app cannot be finished
   until the server has a real domain. See [remote/README.md](remote/README.md): Netlify or
   Vercel plus an Upstash Redis store, or Docker plus Caddy on a VPS. Any of them is minutes.
2. **Your `PUBLIC_URL`**, e.g. `https://ghl.example.com`. Everything below derives from it.
3. **A HighLevel agency account** with marketplace access.

Your redirect URL is:

```
<PUBLIC_URL>/highlevel/callback
```

for example `https://ghl.example.com/highlevel/callback`. Run `node remote/server.js --check`
and it prints the exact string under **Redirect to add** — copy it from there rather than
typing it, because it has to match character for character.

---

## Step 1 — Create the app

1. Go to <https://marketplace.gohighlevel.com> and sign in as the agency.
2. **My Apps → Create App.**
3. Fill in:

   | Field | What to put | Why |
   |---|---|---|
   | **App name** | e.g. `Acme CRM Assistant` | Public apps: this is the listing name. HighLevel suggests the shape `<Brand> for <Service>` |
   | **App type** | **Private** to start with; **Public** when you want it listed | Private is not listed and needs no review |
   | **Target user** | **Sub-account** | The connector works inside one sub-account at a time |
   | **Who can install** | **Both Agency & Sub-account** | Agency installs give the sub-account picker; sub-account installs are the common case |
   | **Listing type** | White-label if you resell HighLevel under your own brand | This has consequences — see the branding warning below |

4. Save. You now have an app you can configure.

---

## Step 2 — Add the redirect URL and scopes

In the app's **Build → Advanced Settings** section:

1. **Redirect URL** — paste `<PUBLIC_URL>/highlevel/callback` and click **Add**. It must be
   HTTPS and must match exactly.
2. **OAuth Scopes** — tick the scopes below. HighLevel reviews apps against the **principle of
   least privilege**, and will reject an app that asks for broad permissions without a
   functional reason, so **only tick what you will actually use**.

The connector's full scope set, and what each one buys you. Trim it to the tools you intend to
let people use:

| Capability | Scopes |
|---|---|
| Contacts, tags, notes, tasks | `contacts.readonly`, `contacts.write` |
| Conversations and messaging | `conversations.readonly`, `conversations.write`, `conversations/message.readonly`, `conversations/message.write` |
| Opportunities and pipelines | `opportunities.readonly`, `opportunities.write` |
| Calendars and appointments | `calendars.readonly`, `calendars.write`, `calendars/events.readonly`, `calendars/events.write` |
| Sub-account details (needed to name the business on the consent screen) | `locations.readonly` |
| Custom fields, custom values, tags | `locations/customFields.readonly` + `.write`, `locations/customValues.readonly` + `.write`, `locations/tags.readonly` + `.write` |
| Sub-account task search | `locations/tasks.readonly`, `locations/tasks.write` |
| Users (to assign work) | `users.readonly` |
| Workflows and campaigns | `workflows.readonly`, `campaigns.readonly` |
| Forms and surveys | `forms.readonly`, `surveys.readonly` |
| Products, invoices, payments | `products.readonly`, `products/prices.readonly`, `invoices.readonly`, `payments/orders.readonly`, `payments/transactions.readonly`, `payments/subscriptions.readonly` |
| Media, links, businesses, blogs, funnels | `medias.readonly`, `links.readonly`, `businesses.readonly`, `blogs/post.readonly`, `funnels/funnel.readonly` |

**The minimum useful set** is `locations.readonly` plus `contacts.readonly` — enough to prove
the connection and look people up. Add the rest as you need them.

The same list, as the connector requests it by default, is in
[`mcp-server/src/config.js`](mcp-server/src/config.js) (`OAUTH_DEFAULT_SCOPES`). If you tick
fewer scopes than that, trim the array to match, or people will see 403s naming scopes they
were never granted.

---

## Step 3 — Generate the client keys

In the app's **Manage → Secrets** section:

1. Under **Client Keys**, click **Add** and give the key pair a name (e.g. `production`).
2. HighLevel shows a **Client ID** and a **Client Secret**.
3. **Copy the Client Secret immediately — it is shown once and cannot be retrieved.**

Put them into the server's environment, never into a file in this repository:

```bash
GHL_CLIENT_ID=<the client id>
GHL_CLIENT_SECRET=<the client secret>
```

With Docker that is two lines in `remote/.env`; on a platform, two entries in its environment
variables panel. Restart the server and run:

```bash
node remote/server.js --check
```

The line `HighLevel app` should now read `configured`, and the warning about
`GHL_CLIENT_ID` should be gone.

---

## Step 4 — Test it end to end

1. Open `<PUBLIC_URL>/` in a browser. The landing page should load and show the connector URL.
2. Add `<PUBLIC_URL>/mcp` as a custom connector in Claude (or any MCP client).
3. You should be sent to the consent screen, and it should now offer **Sign in with
   HighLevel**.
4. Click it. You land on HighLevel's own sign-in, then on a checklist of the sub-accounts
   that login covers. Tick a couple, or **Add all**. (If the login covers exactly one
   sub-account, this screen is skipped.)
5. The next screen shows what is attached. If you run a **second** HighLevel agency, open
   *Work in a second HighLevel account?*, sign in to that one and add its sub-accounts too —
   they join the same connection. Otherwise just **Finish and return to the assistant**.
6. Ask the assistant *"which GHL accounts can you see?"* — `ghl_accounts` should list
   everything you ticked, grouped by CRM.
7. Ask it to *"verify the connection to <one of them>"* — `ghl_whoami` proves that
   credential, location and scopes all work in one call.

If you manage sub-accounts under an agency, install the app on the agency (not a single
sub-account) so the checklist can list them all. A sub-account-level install attaches exactly
that one, which is also fine — it just means one sign-in per sub-account.

If something fails, the failure tells you which part:

| Symptom | Cause |
|---|---|
| HighLevel says the redirect URI is invalid | The redirect URL in the app does not exactly match `<PUBLIC_URL>/highlevel/callback` |
| "Sign-in with HighLevel is not configured" | `GHL_CLIENT_ID`/`GHL_CLIENT_SECRET` are not in the server's environment, or it was not restarted |
| The checklist is empty, with a note that HighLevel would not list them | The app is installed on one sub-account rather than the agency, or `locations.readonly` was not ticked. You can still paste a Location ID on that screen |
| A sub-account you ticked comes back "could not be added" | It is not under the agency you signed into — sign in to that agency and add it there. The others you ticked are still attached |
| Connected, but tools return 401/403 | A scope was not ticked. The error names it. Adding a scope in HighLevel means reconnecting so a new grant is issued |
| The client will not start the flow at all | `PUBLIC_URL` does not match the URL you actually typed, so discovery advertises endpoints that do not resolve |

At this point a private app is **finished**. You have HighLevel sign-in for your agency and
anyone you hand the install link to. Stop here unless you want a public listing.

---

## Step 5 — Going public: what HighLevel will ask for

Switching the app to **Public** puts it through review. Prepare these before you submit.

### The listing

- **App name** — HighLevel suggests `<Brand> for <Service>`.
- **Publisher name** — clearly yours, and clearly associated with the app.
- **Description** — what it does, who it is for, what it costs, and what setup it needs. Say
  plainly that it connects an AI assistant to the user's sub-account through the HighLevel API.
- **Logo and visual assets.**
- **A disclaimer that it is an unofficial integration**, if it is not an official HighLevel
  product. Claiming or implying endorsement is a listed rejection reason.

### Media

Screenshots and video of the thing actually working, in the right user context, with readable
text and decent contrast.

### The demo video (mandatory)

A **Loom demo is required as the final step of the submission flow**, and it must show:

- installing the app,
- configuring it,
- the core functionality working,
- the outcome the user gets,
- the third-party connection (for this connector: the assistant on the other end),
- error handling,
- uninstalling.

For this connector, a demo that covers all of that is roughly: add the connector URL in
Claude → the consent screen → Sign in with HighLevel → tick sub-accounts → Finish → ask it to find a
contact → ask it to send that contact a message and **show it refusing until you confirm** →
confirm and show the message sent → remove the connector. That confirmation step is worth
showing deliberately: it is evidence of the safety behaviour a reviewer is looking for.

### Support

At least one direct channel — email or phone as a minimum — with a **first response within 24
hours**. Set `SUPPORT_EMAIL` so it also appears on the consent screen.

### Legal

A privacy policy and terms of service are **not mandatory**, but you remain responsible for
compliance, and this connector processes other people's customer data. Write them, and point
`PRIVACY_URL` / `TERMS_URL` at them. Cover: what is collected, where it is stored, how it is
protected, and who it is shared with. For this server the honest answer is short — the
GoHighLevel credential and the sub-account id, encrypted at rest on your server; CRM data is
passed through in the moment and not retained.

---

## Step 6 — What the review looks for, and how this connector already answers it

| Review criterion | Where you stand |
|---|---|
| **Functionality** — works consistently as described, complete and testable | The connector is testable end to end; `npm test` at the repository root runs 150 tests across both servers |
| **Least privilege** — only the scopes needed, justifiable on request | Scopes are per-capability (see Step 2); trim them to the tools you ship and you can justify each one |
| **Secrets not in client-side code** | The client secret exists only in the server's environment. The consent page loads no scripts at all, and `.mcp.json`-style placeholders are never real values |
| **Tokens and credentials stored securely** | AES-256-GCM at rest; issued tokens stored as digests only; files `0600` |
| **No customer data leaked through logs, consoles, public URLs or client-side storage** | Logs carry request shapes only. Tokens are scrubbed from every response. The pages set a strict CSP and store nothing |
| **HTTPS** | Required by `--check`, which refuses to start a non-local server on plain HTTP |
| **Responsive UI, no noticeable lag** | The consent screen is a single self-contained page with no external requests |
| **No duplication or corruption on sync** | Writes are confirmation-gated and read-before-write; `ghl_duplicate_check` exists precisely to avoid duplicate contacts |

Listed **rejection reasons** to steer clear of: acting as a sub-marketplace, undisclosed data
extraction, false endorsement or partnership claims, impersonating a third-party service,
requesting unrelated permissions, hidden costs or external requirements, and IP violations.

> **If you chose a white-label listing:** the review requires that white-label apps remove
> "HighLevel", "GHL" and HighLevel branding entirely, using neutral wording like "CRM" or
> "LeadConnector" instead. That affects your listing text **and** the consent screen. Set
> `BRAND_NAME` to something neutral (e.g. `Acme CRM Assistant`), and be aware that the
> connector's own copy says "HighLevel" in places — the strings live in
> [`remote/src/pages.js`](remote/src/pages.js) and
> [`remote/src/instructions.js`](remote/src/instructions.js) if you need to reword them.
> A standard (non-white-label) listing may reference HighLevel factually, which is simpler.

HighLevel does not publish a review turnaround time, so do not schedule anything around it.

---

## After approval

- HighLevel gives the app an **install URL** — that, or your own landing page, is what you
  point people at.
- Adding a scope later means editing the app and having people reconnect: existing grants keep
  the scopes they were issued with.
- Keep the client secret backed up somewhere you control. If it is lost, generate a new key
  pair and update `GHL_CLIENT_SECRET`; existing connections keep working until their access
  tokens expire, then fail to refresh, so redeploy promptly.
- If you rotate `ENCRYPTION_KEY`, every stored connection becomes unreadable and everyone must
  reconnect. Treat it like a database password.

---

## Reference

- Marketplace overview and getting started —
  <https://marketplace.gohighlevel.com/docs/oauth/GettingStarted>
- Create a marketplace app (the fields in Step 1–3) —
  <https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp/index.html>
- App review guidelines (Step 5–6) —
  <https://marketplace.gohighlevel.com/docs/oauth/AppReviewGuidelines>
- OAuth 2.0 flow, token endpoint and location tokens —
  <https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0/>
- Developer marketplace, from HighLevel support —
  <https://help.gohighlevel.com/support/solutions/articles/155000000136-how-to-get-started-with-the-developer-s-marketplace>

Details that matter and are easy to get wrong, confirmed against those pages:

- The redirect URL **must be HTTPS**, backend-controlled, and match the OAuth flow exactly.
- The **client secret is shown once** and cannot be retrieved later.
- HighLevel access tokens last **about 24 hours**; refresh tokens are valid for **a year or
  until used**, and **using one invalidates it** — the response carries a replacement. The
  connector already stores the replacement on every refresh, which is the difference between a
  connection that lasts and one that dies after a day.
