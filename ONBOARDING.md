# GHL Claude Connector — Team Onboarding

**In one sentence:** open a chat, say which client you mean, and just ask for what you need
from GoHighLevel in plain English — no terminal, no code, no PowerShell.

You do **not** need to know how to code. If you can use a browser and copy-paste, you can set
this up in about ten minutes.

---

## The headline feature: one chat, every client

This connector now supports **multiple GoHighLevel sub-accounts from a single ongoing
conversation**. You don't open a different tool, folder, or chat per client — you just name the
client in your request, and Claude uses the right credentials automatically. Today it's already
wired up for:

| Client |
|---|
| MVP Ventures |
| Kellix iQ |
| GSP Events |
| Flout Software |
| Bluebird Childcare |
| Djinda Dreaming Education |
| Chambers Childcare |

You'll only connect the clients **you** personally work with — you don't need all seven.

There is one hard rule baked into this connector, and it exists to protect real client data:
**Claude will never fetch or change anything in a GHL account unless you name that account in
your message.** No client name, no action — Claude will ask which one you mean instead of
guessing. This is true even if you only ever connect one client.

---

## Part 1 — Installing it (step by step, no coding required)

This all happens on **claude.ai/code** (Claude Code on the web) in your browser. You will not
touch a terminal, install anything on your computer, or write a line of code.

### Step 1 — Get access

Make sure you have a Claude account with access to Claude Code on the web. If you're not sure,
ask whoever manages your team's Claude/Anthropic account to confirm or invite you.

### Step 2 — Create your own cloud environment

1. Go to **claude.ai/code** and sign in.
2. Create a **new environment** (this is your own private workspace — don't try to share
   someone else's; see [Why your own environment, not a shared one](#why-your-own-environment-not-a-shared-one)
   below).
3. Give it a name you'll recognize, e.g. `GHL Cloud Environment — <your name>`.
4. Point it at this GitHub repository:
   ```
   https://github.com/jishnu-mvp/ghl-claude-connector
   ```
   branch `main`.

### Step 3 — Allow it to reach HighLevel

Still in that environment's settings:
1. Find **Network access** (it defaults to something restrictive that blocks HighLevel).
2. Change it to **Custom**, and add:
   ```
   services.leadconnectorhq.com
   ```
   If there's no "Custom" option available to you, use **Full network access** instead.
3. Save.

### Step 4 — Get your own token for each client you'll work with

**Important: create your own token, don't reuse anyone else's.** HighLevel's audit log
attributes every change to whichever integration made it — a shared token makes it impossible
to tell who did what, and it's against this project's own rules (see CLAUDE.md).

For **each** client you personally need to work with:

1. Log into HighLevel and switch into that client's sub-account (not agency view).
2. Go to **Settings → Other Settings → Private Integrations → Create new Integration**.
3. Name it after yourself, e.g. `Claude Code — <your name>`.
4. Tick the scopes you need — when in doubt, tick everything available; it's easy to add more
   later (a scope change issues a new token, so you'd just update this one value again).
5. Click Create/Save. HighLevel shows you a token starting with `pit-` — **this is shown once,
   copy it immediately.**
6. Also grab that sub-account's **Location ID** from **Settings → Business Profile**.

### Step 5 — Add your token to the environment

Back in your cloud environment's settings, find **Environment variables**. For each client from
Step 4, add two lines using the **exact variable names already assigned to that client** —
these are fixed by this repo's `accounts.conf` file, so use the table below, not your own names:

| Client | Token variable | Location variable |
|---|---|---|
| MVP Ventures | `GHL_PIT_TOKEN` | `GHL_LOCATION_ID` |
| Kellix iQ | `GHL_PIT_TOKEN_KELLIXIQ` | `GHL_LOCATION_ID_KELLIXIQ` |
| GSP Events | `GHL_PIT_TOKEN_GSP` | `GHL_LOCATION_ID_GSP` |
| Flout Software | `GHL_PIT_TOKEN_FLOUT` | `GHL_LOCATION_ID_FLOUT` |
| Bluebird Childcare | `GHL_PIT_TOKEN_BLUEBIRDCHILDCARE` | `GHL_LOCATION_ID_BLUEBIRDCHILDCARE` |
| Djinda Dreaming Education | `GHL_PIT_TOKEN_DJINDADREAMING` | `GHL_LOCATION_ID_DJINDADREAMING` |
| Chambers Childcare | `GHL_PIT_TOKEN_CHAMBERSCHILDCARE` | `GHL_LOCATION_ID_CHAMBERSCHILDCARE` |

Example, if you're connecting Kellix iQ:
```
GHL_PIT_TOKEN_KELLIXIQ=pit-...your-own-token...
GHL_LOCATION_ID_KELLIXIQ=...that-sub-account's-location-id...
```

**Formatting rules that matter** (this trips people up):
- No space before or after the `=`.
- No space inside the variable name.
- One `KEY=value` pair per line.

Only add the clients *you* actually work with. Skip the rest.

Want to add a client that **isn't** in the table above? That's an additive step, not a
re-install — see [accounts.conf](accounts.conf) in the repo for the exact instructions, or just
ask Claude to walk you through it once you're set up.

### Step 6 — Save, and start a new chat

Save your environment settings. Then start a **new chat** in that environment (environment
variable changes only apply to chats started after you save them — if you ask a question in a
chat that predates the save, it won't see your new values).

### Step 7 — Try it

Ask something simple and safe first, naming a client you connected:
> "Check that you're connected to Kellix iQ and tell me the business name."

If that comes back correctly, you're fully set up.

### Why your own environment, not a shared one

Two people sharing one environment means sharing one set of credentials — every action gets
attributed to one name in HighLevel's audit trail, and there's no way to tell who actually did
what. It also means unrelated conversations pile up in the same place. Each person gets their
own environment (same shared repo/code, personal credentials and chat history).

---

## Part 2 — What this connector can actually do

This isn't a guess — it's from a real, live verification run across all seven connected
accounts, checking each area of the API directly rather than assuming from documentation.

### ✅ Confirmed working, for every connected client

| Area | What you can ask for |
|---|---|
| **Contacts** | Search, view, create, update, delete · duplicate-check by email · tags · notes · tasks · their appointments |
| **Conversations & messaging** | Search threads, read full message history, **send SMS/email** *(Claude always confirms first — reaches a real person)* |
| **Sales (opportunities/pipelines)** | List pipelines & stages · search/create/update deals · move stages · mark won/lost/abandoned |
| **Calendars & appointments** | List calendars, check free slots, list events, **book/reschedule/cancel appointments** *(always confirms first)* |
| **Automation** | List workflows & campaigns, **enroll/remove a contact** *(always confirms first — this fires live automations)* |
| **Setup & configuration** | Custom fields, custom values, tag lists, users/staff, sub-account details |
| **Lead intake** | Forms + their submissions, surveys + their submissions |
| **Money** | Products & prices, invoices (create/send/void/record payment), orders, transactions, subscriptions |
| **Content & assets** | Funnels (read), trigger links, businesses, media library, email templates, blog sites, social planner posts |
| **The escape hatch** | Any other HighLevel v2 API endpoint not listed above, via a direct request |

Real examples you can just type:
> "Find the contact for jane@example.com in Chambers Childcare and show me her tags."

> "For Kellix iQ, list every deal in the Sales pipeline sitting in the Proposal stage."

> "Compare this month's new contact counts between GSP Events and Flout Software."

> "Add the tag `follow-up-q3` to contact abc123 in Bluebird Childcare." *(Claude will describe
> the exact change and wait for you to say yes first)*

### ❌ What's not possible — even with full permissions

These are hard limits of HighLevel's own API, not something more setup fixes:

| Not possible | Why |
|---|---|
| Building a workflow, funnel, or email template design | HighLevel has no API for *authoring* these — UI-only, always. Claude can enroll contacts into an existing workflow and read the list, but can't build one. |
| "Run this workflow right now" | No such endpoint exists. The only way in is enrolling a contact (which triggers it), or an Inbound Webhook set up inside the workflow. |
| Undoing a change | No undo, no sandbox, ever. This is exactly why Claude confirms before anything that writes. |
| Agency-wide operations (e.g. listing other sub-accounts, snapshots, billing) | A sub-account token structurally cannot do this — confirmed with a `403` on every single connected account. Would need a separate, bigger-scope agency credential. |
| Custom menu links | Found one consistent gap here across every account — a clean scope refusal that doesn't seem to be exposed through Private Integrations at all, regardless of what's ticked. Minor; unlikely to matter day to day. |

### The two safety habits worth knowing before you start

1. **Claude reads before it writes, and re-reads after to confirm** — it doesn't just trust that
   an update succeeded.
2. **Claude asks before anything outbound** — a message, an appointment, a workflow enrollment.
   Read the exact description of what it's about to do before you say yes, especially your
   first few times using it.

Full rules live in [CLAUDE.md](CLAUDE.md); the complete command reference is in
[SKILL.md](.claude/skills/ghl/SKILL.md).

---

## FAQ

**Do I need to know how to code?**
No. Everything above happens by clicking through web pages and pasting values into a couple of
text boxes. Once it's set up, you just type or talk in plain English.

**What if I only need one client, not all seven?**
Totally fine — only do Step 4/5 for the client(s) you actually work with.

**I added my token but Claude says it's not connected.**
Make sure you started a **new chat** after saving the environment variables — an already-open
chat won't see values added after it started.

**Can I share my token with a teammate to save time?**
No — each person creates their own, even for the same client. It's fast (a couple of minutes)
and it's the only way HighLevel's audit trail stays meaningful.

**Something's not working and I can't tell why.**
Ask Claude directly, in your chat — describe exactly what you see. It's built to explain GHL/API
errors in plain language rather than leaving you stuck.
