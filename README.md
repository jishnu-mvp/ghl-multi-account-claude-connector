# GHL Claude Connector — GoHighLevel + Claude Code

**In one sentence:** fill in one token in one file, and then you can just *talk to your
GoHighLevel CRM in plain English* — "find every contact tagged `hot-lead` who hasn't been
messaged in 30 days" — and Claude will do it for you.

You do **not** need to be a developer to use this. You do **not** need to know what an API is.
If you can copy and paste, you can set this up.

---

## Contents

1. [What is this, really?](#1-what-is-this-really)
2. [Words you'll see, in plain English](#2-words-youll-see-in-plain-english)
3. [Before you start (one-time, per computer)](#3-before-you-start-one-time-per-computer)
4. [Setup — the 3 steps](#4-setup--the-3-steps)
5. [Check it worked](#5-check-it-worked)
6. [Using it: things you can just ask for](#6-using-it-things-you-can-just-ask-for)
7. [Command examples (the cookbook)](#7-command-examples-the-cookbook)
8. [The two roads to GoHighLevel (API vs MCP)](#8-the-two-roads-to-gohighlevel-api-vs-mcp)
9. [Everything Claude can touch](#9-everything-claude-can-touch)
10. [What it deliberately cannot do](#10-what-it-deliberately-cannot-do)
11. [Safety: this is your real CRM](#11-safety-this-is-your-real-crm)
12. [When something breaks](#12-when-something-breaks)
13. [Scopes — the #1 cause of confusing errors](#13-scopes--the-1-cause-of-confusing-errors)
14. [Every file, and what it's for](#14-every-file-and-what-its-for)
15. [FAQ](#15-faq)
16. [Working with more than one sub-account](#16-working-with-more-than-one-sub-account)

---

## 1. What is this, really?

Claude Code is Claude running in your terminal, able to read files and run commands. Out of the
box it knows nothing about *your* GoHighLevel account.

This repo is the missing bridge. Open it in Claude Code and every session gains:

| What you get | What it means for you |
|---|---|
| **Working rules** — [CLAUDE.md](CLAUDE.md) | Claude reads this automatically, every session. It's the rulebook: how to reach your CRM, and — importantly — what it must **never** do without asking you first. |
| **A `/ghl` toolkit** — [SKILL.md](.claude/skills/ghl/SKILL.md) | Around 70 ready-made commands (contacts, messages, deals, appointments, invoices…) plus the full reference. Claude uses these instead of guessing. |
| **One credential for everything** | A single **Private Integration Token** unlocks both ways of reaching GoHighLevel. No OAuth app, no old v1 API key, no second password. |
| **Safe secret handling** | Your token lives in a file called `.env` that git is told to ignore. It never gets committed or shared. |
| **A startup safety check** | Every time Claude starts, it checks your setup and *tells you inside the chat* if something's missing. You can't silently end up half-configured. |

**The point:** you describe the outcome you want; Claude figures out which CRM operations to
run. You stop clicking through the HighLevel UI for repetitive work.

---

## 2. Words you'll see, in plain English

Skim this once and the rest of the document will make sense.

| Word | What it actually means |
|---|---|
| **GoHighLevel / HighLevel / LeadConnector** | Three names for the same product. HighLevel is the company; LeadConnector is the white-label brand the technical bits are named after. If you see any of them, think "the CRM". |
| **Sub-account** | One client/business inside HighLevel. Also called a **Location**. |
| **Location ID** | The ID number of that sub-account. Almost everything needs it, so we save it once. |
| **Agency account** | The top-level account that owns many sub-accounts. |
| **API** | A way for software to talk to software instead of a human clicking buttons. It's how Claude reads and changes your CRM. |
| **Private Integration Token (PIT)** | A long password-like string starting with `pit-` that you generate inside HighLevel. It proves it's *you* asking, and controls exactly what may be touched. This is the one secret you need. |
| **Scope** | A permission ticked on the token. `contacts.readonly` = "may read contacts". No scope = the request is refused. |
| **MCP** | A standard way to plug external tools into an AI. HighLevel hosts an official one. It's the *conversational* road to your CRM. |
| **`.env`** | A plain text file holding your secrets. Git is configured to ignore it, so it stays on your machine only. |
| **Skill** | A pack of instructions + scripts Claude can load. Ours is called `/ghl`. |
| **Hook** | A small script that runs automatically at a set moment. Ours runs at startup to check your setup. |
| **Terminal** | The text window where you type commands. Terminal on Mac, PowerShell on Windows. |

---

## 3. Before you start (one-time, per computer)

You need three things. Most people already have all three.

**a) Claude Code installed.** Check by typing this in your terminal:
```
claude --version
```
If that prints a version number, you're good. If it says "command not found", install it from
<https://claude.com/claude-code> first.

**b) Access to the HighLevel sub-account** you'll be working on, with permission to create a
Private Integration. If **Settings → Other Settings → Private Integrations** doesn't exist for
you, an admin needs to enable it — ask them.

**c) A terminal open in this folder.** Easiest way: open this folder in VS Code and use its
built-in terminal (**Terminal → New Terminal**). Or in a terminal, `cd` into the folder:
```
cd path/to/ghl-claude-connector
```

> **How do I know I'm in the right folder?** Run `ls` (Mac/Linux) or `dir` (Windows). You should
> see `setup.sh`, `CLAUDE.md`, and `README.md` listed.

---

## 4. Setup — the 3 steps

Total time: about two minutes. Do these in order.

### Step 1 — Run the setup script

This creates your personal `.env` file and tells you exactly what's still missing. It doesn't
change anything else, and it's safe to run as many times as you like.

**Windows (PowerShell):**
```powershell
.\setup.ps1
```

**Mac / Linux:**
```bash
./setup.sh
```

You'll see something like:

```
=== GoHighLevel + Claude Code setup ===
Created .env from .env.example.

Still need to fill in: GHL_PIT_TOKEN GHL_LOCATION_ID

Open .env and set:
  GHL_PIT_TOKEN     HighLevel → Settings → Other Settings → Private Integrations
                    → Create new Integration → tick scopes → copy the pit-… token
  GHL_LOCATION_ID   HighLevel → Settings → Business Profile → Location ID
```

That's the script doing its job — it's telling you what Step 2 is.

> **"Permission denied" on Mac/Linux?** If you received this folder as a **zip** rather than a
> `git clone`, the scripts may not be marked executable. Either put `bash` in front —
> `bash setup.sh` — which always works, or fix it once:
> ```bash
> chmod +x setup.sh claude-here.sh .claude/skills/ghl/scripts/ghl.sh
> ```

### Step 2 — Get your two values from HighLevel

You need a **token** and a **Location ID**. Both come from the HighLevel web app.

#### 2a. Your Private Integration Token

1. Log in to HighLevel and switch into the **sub-account** you'll be working on (not the agency
   view).
2. Go to **Settings → Other Settings → Private Integrations**.
3. Click **Create new Integration**.
4. **Name it after yourself**, e.g. `Claude Code — Jishnu`. This matters: HighLevel's audit log
   will show this name against every change.
5. **Tick the scopes** (permissions) you need. Not sure? A sensible starting set for general CRM
   work:

   ```
   contacts.readonly            contacts.write
   conversations.readonly       conversations.write
   conversations/message.readonly   conversations/message.write
   opportunities.readonly       opportunities.write
   calendars.readonly           calendars.write
   calendars/events.readonly    calendars/events.write
   locations.readonly           locations/customFields.readonly
   locations/tags.readonly      users.readonly
   ```

   You can always add more later (see [section 13](#13-scopes--the-1-cause-of-confusing-errors)).
   Fewer scopes = safer.
6. Save, then **copy the token**. It starts with `pit-`.

> ### ⚠️ The single most important warning in this document
> **The token is shown exactly once.** Close that dialog without copying it and it's gone
> forever — you'd have to delete the integration and make a new one. Paste it straight into
> `.env` (Step 3) before you click away.

#### 2b. Your Location ID

Go to **Settings → Business Profile**. The **Location ID** is listed there. (It's also the long
string in your browser's address bar when you're inside the sub-account.)

### Step 3 — Paste both values into `.env`

Open the `.env` file that Step 1 created. Any text editor works — VS Code, Notepad, TextEdit.
Fill in the two blank lines:

```bash
GHL_PIT_TOKEN=pit-abc12345-6789-def0-1234-56789abcdef0
GHL_LOCATION_ID=Xy7KpQ2mNvB4rT8wLcE1
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
```

Rules for this file — all three matter:

- **No spaces around the `=`.** `GHL_PIT_TOKEN=pit-abc` ✅ · `GHL_PIT_TOKEN = pit-abc` ❌
- **No quotes needed.** Just paste the raw value.
- **Leave the bottom two lines alone.** They're correct defaults.

Save the file, then **run the setup script again** to confirm:

```
All values are set. You are ready.
Test the API:  ./.claude/skills/ghl/scripts/ghl.sh whoami
Launch Claude: ./claude-here.sh
```

🎉 That's the setup done.

### Then: always start Claude with the launcher

**Windows:**
```powershell
.\claude-here.ps1
```
**Mac / Linux:**
```bash
./claude-here.sh
```

**Why not just type `claude`?** Because the launcher loads your `.env` into the session first.
Without it, the conversational MCP tools can't see your token and won't connect. The `/ghl`
commands would still work (they read `.env` themselves) — but you'd be running with one road
closed for no reason. Make the launcher your habit.

---

## 5. Check it worked

Run the built-in connection test. It's read-only and completely safe:

**Windows:** `.\.claude\skills\ghl\scripts\ghl.ps1 whoami`
**Mac / Linux:** `./.claude/skills/ghl/scripts/ghl.sh whoami`

A healthy result looks like this:

```
Base URL   : https://services.leadconnectorhq.com
Version    : 2021-07-28
Location   : Xy7KpQ2mNvB4rT8wLcE1
Token      : pit-abc1… (44 chars)
Company    : <not set>

Probing GET /locations/$GHL_LOCATION_ID …
{
  "location": {
    "name": "Acme Dental",
    ...
  }
}
```

Three things to notice:

- Your **token is never printed in full** — only the first few characters, so it's safe to
  screenshot or paste into Slack when asking for help.
- Seeing your **real business name** back from HighLevel proves the token, the Location ID, and
  your scopes are all correct.
- `Company : <not set>` is **normal and fine** — that's only for agency-wide work.

Anything else, jump to [section 12: When something breaks](#12-when-something-breaks).

You can also check the conversational side. Inside Claude, type:
```
/mcp
```
`leadconnector` should be listed as connected. If it isn't, you probably started `claude`
directly instead of using the launcher — quit and relaunch with `claude-here`.

---

## 6. Using it: things you can just ask for

You don't run commands yourself. You describe what you want in the chat and Claude picks the
right operation. Real examples:

**Looking things up**
> "Find the contact with email jane@example.com and show me her tags and recent notes."

> "How many contacts do we have tagged `webinar-may`?"

> "List every deal in the Sales pipeline sitting in the Proposal stage, sorted by value."

> "What did we last say to contact ID `abc123`? Show me the conversation."

**Understanding your setup**
> "List our pipelines and all their stages."

> "What custom fields exist on contacts in this sub-account?"

> "Show me our tag list — I want to find near-duplicate tags."

**Reporting**
> "Export every contact created in the last 30 days to a CSV, with name, email, phone and tags."

> "Which form has the most submissions this month?"

> "Summarise the appointments booked next week, grouped by calendar."

**Making changes** *(Claude will describe the change and ask you to confirm first)*
> "Add the tag `follow-up-q3` to contact abc123."

> "Move deal xyz789 to the Closed Won stage."

> "Create a contact for John Smith, john@acme.com, +61400000000, tagged `inbound-call`."

**Bigger jobs**
> "Find contacts with no phone number but a valid email, and give me the list — don't change
> anything yet."

> "Look for duplicate contacts by email and show me the pairs before we merge anything."

### Two habits that make this work well

1. **Ask for the read before the write.** "Show me the contacts you'd change" and *then* "OK, do
   it." Claude is instructed to work this way, but leading with it makes you faster and safer.
2. **Say "don't change anything yet" when exploring.** Removes all ambiguity.

---

## 7. Command examples (the cookbook)

**Read this as reference, not homework.** Normally you just ask in English (section 6) and Claude
runs these for you. This section exists so you can (a) see what's actually happening under the
hood, (b) run something yourself when you want exact control, and (c) recognise the commands
when Claude shows you what it's about to do.

### How to read the examples

Every example below is written as `ghl <command>`. Replace `ghl` with the real path for your
computer:

```bash
./.claude/skills/ghl/scripts/ghl.sh   <command> [args]     # Mac / Linux
```
```powershell
.\.claude\skills\ghl\scripts\ghl.ps1  <command> [args]     # Windows
```

Both accept **exactly the same commands** — they're deliberate twins.

Three things that apply everywhere:

- **IDs shown as `C1`, `CAL_ID`, `YOUR_LOC` are placeholders.** Replace them with real ones. Get
  real ones by listing first (`ghl list-contacts`, `ghl list-calendars`, `ghl list-pipelines`).
- **Anywhere an example passes JSON, you can pass a file path instead** — nicer for anything
  long: `ghl create-contact ./new-contact.json`
- **Quote any path containing `?` or `&`**, or your shell will mangle it.

### Start here

```bash
ghl                    # print the whole command list (works before setup is finished)
ghl whoami             # prove your token + Location ID + scopes all work — read-only, always safe
```

`whoami` is the one command worth memorising. Run it first whenever anything looks wrong.

### Contacts

Finding and reading:
```bash
ghl list-contacts                          # first 100 contacts in the sub-account
ghl list-contacts jane                     # free-text search
ghl list-contacts jane@example.com         # search by email
ghl get-contact C1                         # one full record
ghl duplicate-check jane@example.com       # does this email already exist?
ghl export-contact C1                      # save to contact-C1.json (back up before editing)
```

Creating — `locationId` **is** required in the body here:
```bash
ghl create-contact '{"locationId":"YOUR_LOC","firstName":"John","lastName":"Smith","email":"john@acme.com","phone":"+61400000000","tags":["inbound-call"]}'
```

Updating — `locationId` **must not** be in the body (including it causes an error):
```bash
ghl update-contact C1 '{"firstName":"Jonathan"}'
```

Tags, notes and tasks:
```bash
ghl add-tags    C1 hot-lead,webinar-may
ghl remove-tags C1 cold-lead
ghl contact-notes C1
ghl add-note      C1 "Called — wants a quote by Friday"
ghl contact-tasks C1
ghl add-task      C1 '{"title":"Send quote","dueDate":"2026-08-12T09:00:00Z","completed":false}'
```

For anything more selective than a keyword search, `search-contacts` is the real tool — it
supports filters, sorting and paging:
```bash
ghl search-contacts '{"locationId":"YOUR_LOC","page":1,"pageLimit":50,"filters":[{"field":"tags","operator":"contains","value":"hot-lead"}]}'
```

### Deals (opportunities)

**Always list the pipelines first.** Stage IDs are random-looking strings — they can't be
guessed, and a wrong one silently puts the deal in the wrong place:
```bash
ghl list-pipelines                          # pipelines AND their stage ids
ghl search-opportunities                    # all deals
ghl search-opportunities PIPELINE_ID        # deals in one pipeline
ghl get-opportunity OPP_ID
```

```bash
ghl create-opportunity '{"locationId":"YOUR_LOC","pipelineId":"P1","pipelineStageId":"S1","name":"Acme — website rebuild","status":"open","contactId":"C1","monetaryValue":12000}'
ghl update-opportunity OPP_ID '{"pipelineStageId":"S3"}'      # move it to another stage
ghl set-opportunity-status OPP_ID won                          # open | won | lost | abandoned
```

### Calendars and appointments

Time arguments here are **epoch milliseconds** — a big number, not a date string. That's
HighLevel's requirement, not ours:

```bash
ghl list-calendars
ghl free-slots CAL_ID 1754352000000 1754956800000     # what's bookable in this window
ghl list-events 1754352000000 1754956800000           # everything in the sub-account
ghl list-events 1754352000000 1754956800000 CAL_ID    # one calendar only
ghl get-appointment EVENT_ID
```

To get today's number:
```bash
date -v+0d +%s000        # macOS
date -d 'now' +%s000     # Linux
```
Or just ask Claude — "what's the epoch-ms for next Monday 9am Sydney time?"

```bash
# ⚠️ These book/change a real slot in a real calendar — Claude confirms with you first
ghl create-appointment '{"calendarId":"CAL_ID","locationId":"YOUR_LOC","contactId":"C1","startTime":"2026-08-12T10:00:00+10:00","title":"Discovery call"}'
ghl update-appointment EVENT_ID '{"startTime":"2026-08-13T10:00:00+10:00"}'
ghl delete-event EVENT_ID
```

### Conversations and messaging

Reading is safe:
```bash
ghl list-conversations                        # recent threads
ghl list-conversations C1                     # one contact's threads
ghl messages CONVERSATION_ID                  # full message history
```

Sending is not:
```bash
# ⚠️ This reaches a real phone or inbox. Claude confirms first.
# When testing, always target YOUR OWN number/email.
ghl send-message '{"type":"SMS","contactId":"C1","message":"Hi Jane, following up on your quote."}'
ghl send-message '{"type":"Email","contactId":"C1","subject":"Your quote","html":"<p>Attached.</p>"}'
```

### Configuration lookups

These are the ones you'll use constantly, because they turn names into the IDs everything else
needs:
```bash
ghl custom-fields        # field definitions + their ids — never hardcode these
ghl custom-values
ghl list-tags            # check before inventing a tag: HighLevel creates tags silently on
                         # write, so one typo becomes permanent clutter
ghl list-users
ghl get-location         # sub-account details — also what `whoami` probes
```

### Lead intake, automation and money

```bash
ghl list-forms
ghl form-submissions                  # across all forms
ghl form-submissions FORM_ID          # one form
ghl list-surveys
ghl survey-submissions SURVEY_ID

ghl list-workflows
ghl add-to-workflow      C1 WORKFLOW_ID    # ⚠️ fires live automations — Claude confirms first
ghl remove-from-workflow C1 WORKFLOW_ID
ghl list-campaigns

ghl list-products
ghl product-prices PRODUCT_ID
ghl list-invoices
ghl list-orders
ghl list-transactions
ghl list-subscriptions
```

### The escape hatch: `raw`

There are more HighLevel endpoints than we made shortcuts for. `raw` reaches **any** of them:

```bash
ghl raw GET  '/contacts/?locationId=YOUR_LOC&limit=5'
ghl raw POST /contacts/upsert '{"locationId":"YOUR_LOC","email":"jane@example.com","tags":["vip"]}'
ghl raw PUT  /opportunities/OPP_ID '{"monetaryValue":15000}'
ghl raw GET  '/blogs/site/all?locationId=YOUR_LOC&limit=10'
```

You rarely need this yourself — it's mainly how Claude reaches the long tail of the CRM. The full
endpoint list is in [SKILL.md](.claude/skills/ghl/SKILL.md).

### The pattern that matters most

Read → back up → change → verify. This is what [CLAUDE.md](CLAUDE.md) requires of Claude, and
it's a good habit for you too:

```bash
ghl get-contact C1                     # 1. look at what's there now
ghl export-contact C1 backup-C1.json   # 2. back it up
ghl add-tags C1 qualified               # 3. make the change
ghl get-contact C1                      # 4. confirm it actually landed
```

Step 4 is not paranoia. A successful-looking response is not proof the field changed — only
re-reading the record is.

---

## 8. The two roads to GoHighLevel (API vs MCP)

There are two ways in, and **both use the same token you already pasted** — nothing extra to set
up. You don't have to choose; Claude follows the rules in [CLAUDE.md](CLAUDE.md) automatically.
This section is just so nothing surprises you.

Think of it as a **workshop** versus a **helpdesk**:

### Road 1 — The REST API, via the `/ghl` skill 🔧 *the workshop*
Complete, precise, scriptable. Every operation HighLevel offers, with exact control. This is the
**default**, and it's what gets used for anything that matters: bulk work, exports, careful
field-level edits, repeatable jobs.

### Road 2 — The LeadConnector MCP 💬 *the helpdesk*
HighLevel's own official AI connector. Great for quick conversational lookups. Smaller and more
restricted — it can't do everything the API can.

| Situation | Road used |
|---|---|
| Bulk work: export all, batch tag, dedupe, migrate | 🔧 API |
| Careful edits to specific fields, custom fields & values | 🔧 API |
| Forms, surveys, media, blogs, funnels, invoices, users | 🔧 API |
| Anything scheduled or repeatable | 🔧 API |
| "Find the contact for jane@example.com" | 💬 MCP |
| A quick one-off read mid-conversation | 💬 MCP |
| Checking what fields an operation needs before writing | 💬 MCP |
| Listing sub-accounts (agency connection) | 💬 MCP |

**The rule in one line:** the API is the superset, so it's the default; the MCP is a convenience
layer. If an MCP tool is missing or errors, Claude falls back to the API automatically.

**If the MCP never connects, nothing is lost** — the `/ghl` skill covers everything and reads
`.env` directly. Fix it when convenient: [.claude/mcp-setup.md](.claude/mcp-setup.md).

---

## 9. Everything Claude can touch

Subject to your token's scopes and the confirmation rules in [CLAUDE.md](CLAUDE.md):

| Area | What's available |
|---|---|
| **Contacts** | search, list, get, create, update, upsert, delete · duplicate-check by email · add/remove tags · notes · tasks · their appointments |
| **Conversations** | search threads · read full message history · **send SMS or email** *(asks you first)* |
| **Sales** | list pipelines & their stages · search/create/update deals · move stages · mark won / lost / abandoned |
| **Calendars** | list calendars · query free slots · list events · **book, reschedule, cancel appointments** *(asks you first)* |
| **Automation** | list workflows & campaigns · **enrol or remove contacts** *(asks you first)* |
| **Setup & config** | custom fields · custom values · tag list · users/staff · custom menus · sub-account details |
| **Lead intake** | forms & their submissions · surveys & their submissions |
| **Money** | products & prices · invoices (create, send, void, record payment) · orders · transactions · subscriptions |
| **Content & assets** | funnels · trigger links · businesses · media library · email templates · blogs · social planner posts |
| **Anything else** | an escape hatch that reaches *any* HighLevel API endpoint, even ones not listed above |

Around **70 ready commands**, ~20 areas of the CRM. The full reference with exact fields is in
[SKILL.md](.claude/skills/ghl/SKILL.md).

---

## 10. What it deliberately cannot do

Honest limits, so you don't waste time trying:

| Not possible | Why, and what to do instead |
|---|---|
| **Build a workflow, funnel, or email design** | HighLevel doesn't expose these for creation. Build them in the UI once; Claude can then enrol contacts into them and read the list. |
| **"Run this workflow now"** | No such operation exists. Add the contact to the workflow (which triggers it), or put an Inbound Webhook trigger in the workflow and have Claude call that URL. |
| **Agency-level work** — creating sub-accounts, snapshots, SaaS billing | Needs an **agency-level** token or a full OAuth app. A sub-account token gets refused. Claude will tell you rather than working around it. |
| **Undo a change** | There is no undo, and no sandbox. This is why confirmation-before-write exists. See [section 11](#11-safety-this-is-your-real-crm). |
| **Work without the right scope** | A missing permission is a hard refusal, not something to retry. See [section 13](#13-scopes--the-1-cause-of-confusing-errors). |

---

## 11. Safety: this is your real CRM

**There is no test mode and no undo button.** Every contact here is a real person; a sent
message actually reaches their phone. Treat it as production at all times.

The safety rules are written into [CLAUDE.md](CLAUDE.md), which Claude loads automatically each
session. In plain terms:

**Claude will always ask you first before:**
- 📱 Sending any SMS, email, or message to a contact
- 📅 Booking, rescheduling, or cancelling an appointment
- ⚙️ Adding or removing a contact from a workflow or campaign *(this fires live automations)*
- 🗑️ Deleting anything
- 📦 Changing many records at once — it states the count and the exact change first

**Claude will always:**
- Read a record before changing it, and back it up first
- Re-read the record afterwards to confirm the change actually landed
- Look up real IDs (pipeline stages, custom fields, calendars) rather than guessing them
- Stop and tell you the missing scope on a permission error, instead of retrying blindly
- Keep your token and customer data out of anything it prints or commits

**You should:**
- Test on a throwaway contact you created — name it `zzz-test-something` so it's obvious
- Use **your own** phone number and email when testing messaging
- Run any bulk job on **one** record first, look at the result, then scale up
- Never commit `.env`, and never share your token

**About privacy:** contact records, conversation transcripts, and form submissions are personal
data. Don't paste raw exports into tickets, docs, or third-party tools. `.gitignore` already
blocks the common export filenames from being committed by accident.

---

## 12. When something breaks

Work down the table — it's ordered from most to least common.

| What you see | What's wrong | Fix |
|---|---|---|
| `Permission denied` running `./setup.sh` | Zip download lost the executable flag | Use `bash setup.sh`, or `chmod +x setup.sh claude-here.sh .claude/skills/ghl/scripts/ghl.sh` |
| `No .env found` | Step 1 not done, or you're in the wrong folder | Run the setup script from inside this folder. `ls` should show `CLAUDE.md`. |
| `GHL_PIT_TOKEN is not set in .env` | Blank, or a stray space around the `=` | Open `.env`; make it exactly `GHL_PIT_TOKEN=pit-…`, no spaces, no quotes |
| `GHL_LOCATION_ID is not set` | Location ID missing | HighLevel → Settings → Business Profile → Location ID |
| **`401 Unauthorized`** | Token is wrong, was deleted, or isn't a Private Integration Token | Confirm it starts with `pit-`. An old v1 API key or a long `eyJ…` JWT will **not** work — create a Private Integration. |
| **`403 Forbidden`** on some things but not others | Token is valid but **missing a scope** | Add the scope in HighLevel → this issues a **new token** → update `.env`. See [section 13](#13-scopes--the-1-cause-of-confusing-errors). |
| Results come back empty, no error | Wrong Location ID — you're querying an empty/other sub-account | Re-check Settings → Business Profile. `whoami` should print the right business name. |
| `leadconnector` shows **failed** in `/mcp` | Started `claude` directly, so the token wasn't in the session | Quit; relaunch with `./claude-here.sh` / `.\claude-here.ps1` |
| **`429 Too Many Requests`** | Hit the rate limit (~100 requests / 10 seconds) | Wait a moment and ask Claude to batch the work. Don't retry in a tight loop. |
| A confusing `4xx` on an operation that should work | A required header was dropped | Always use the `/ghl` helper scripts, never hand-written requests — they attach all required headers, including the easily-forgotten `Version` |
| Agency-level operations refused | Sub-account token can't do agency work | Needs an agency-level token or OAuth app |
| Claude says setup is incomplete at startup | The startup hook found a gap | Read its message — it names the exact missing value |

**Still stuck?** Run `whoami` and share its output. It's safe to paste anywhere: it shows only
the first few characters of your token. Deeper MCP troubleshooting lives in
[.claude/mcp-setup.md](.claude/mcp-setup.md).

---

## 13. Scopes — the #1 cause of confusing errors

Worth understanding properly, because it explains most "but it worked yesterday" moments.

Your token only carries the permissions you ticked **at the moment you created it**. Ask for
something outside them and HighLevel refuses with a `401`/`403` — even though the token is
perfectly valid. That's why one operation works and the next one fails.

Two things people trip on:

1. **Adding a scope issues a NEW token.** The old string keeps its old permissions forever. So
   after editing scopes in HighLevel you must **copy the new token into `.env`** — otherwise
   nothing changes and it looks like the fix didn't work.
2. **Claude won't paper over it.** It's instructed to stop and name the scope you need, rather
   than retrying or quietly trying a different endpoint. If it reports a missing scope, that's
   the real answer.

Rough guide to which scopes power what:

| To do this… | Tick these |
|---|---|
| Read & write contacts, tags, notes, tasks | `contacts.readonly`, `contacts.write` |
| Read conversations & send messages | `conversations.*`, `conversations/message.*` |
| Deals & pipelines | `opportunities.readonly`, `opportunities.write` |
| Calendars, slots, appointments | `calendars.*`, `calendars/events.*` |
| Custom fields, custom values, tags | `locations/customFields.*`, `locations/customValues.*`, `locations/tags.*` |
| Sub-account details | `locations.readonly` |
| Staff / users | `users.readonly` |
| Workflows & campaigns | `workflows.readonly`, `campaigns.readonly` |
| Form & survey submissions | `forms.readonly`, `surveys.readonly` |
| Products, invoices, payments | `products.*`, `invoices.*`, `payments/*` |
| Media, links, blogs, social | `medias.*`, `links.*`, `blogs.*`, `socialplanner/*` |

The complete map is in
[SKILL.md](.claude/skills/ghl/SKILL.md#4-scopes-the-1-cause-of-4xx).

---

## 14. Every file, and what it's for

Nothing here is mysterious — here's the whole repo.

```
CLAUDE.md              The rulebook. Claude reads it automatically every session.
README.md              This guide (for humans).
setup.ps1 / setup.sh   Step 1: creates .env, tells you what's missing. Safe to re-run.
claude-here.ps1 / .sh  How you start Claude. Loads .env first so both roads work.
.env.example           The blank template. Copied to .env by the setup script.
.env                   YOUR SECRETS. Created by setup. Never committed. Not in the repo.
accounts.conf          Registry of GHL sub-accounts this connector knows about (aliases +
                       display names + which env vars hold each one's token/location).
                       No secrets in this file — safe to read and commit.
.mcp.json              Registers HighLevel's official MCP. Reads your token from the
                       environment — the real value is never written into this file.
.gitignore             Blocks .env, CRM exports and CSVs from ever being committed.
.gitattributes         Line-ending housekeeping so scripts run on both Windows and Mac.

.claude/
  settings.json        Turns on the startup check.
  mcp-setup.md          Deep dive + troubleshooting for the MCP connection.
  hooks/
    check-ghl-env.js   The startup check. Inspects your setup and reports gaps in the chat.
  skills/ghl/
    SKILL.md           The /ghl toolkit: command list, full endpoint reference, scope map.
    scripts/
      ghl.ps1          The ~70 commands, for Windows.
      ghl.sh           The same ~70 commands, for Mac/Linux.
```

---

## 15. FAQ

**Do I need to know how to code?**
No. You type requests in plain English. The scripts exist so *Claude* has reliable tools; you
never have to run them yourself (except `whoami`, to check your setup).

**Can I share my token with a teammate?**
No — and there's a practical reason beyond security. HighLevel's audit log attributes changes to
the integration, so a shared token makes it impossible to tell who did what. Everyone creates
their own, named after themselves. Setup takes two minutes.

**I lost my token. What now?**
It can't be recovered — HighLevel shows it once. Delete that integration, create a new one, and
paste the new token into `.env`.

**Does the token expire?**
No. It's long-lived, which is also why you should treat it like a password. Rotate it about every
90 days: create a new integration, swap `.env`, delete the old one.

**How do I revoke access?**
Delete the integration in HighLevel → Settings → Other Settings → Private Integrations. The token
stops working immediately.

**Will this touch other sub-accounts?**
Only the ones you've actually registered. Each sub-account needs its own Private Integration
Token (a token only sees the one Location it was created in) — but you don't need a separate
copy of this repo per sub-account. Add the new token/Location ID as env vars, add one line to
[accounts.conf](accounts.conf), and Claude can work with either sub-account in the same
ongoing chat by name — e.g. *"for Client A, list contacts tagged hot-lead"*. See
[section 16](#16-working-with-more-than-one-sub-account) for the exact steps.

**Is `.env` really safe from being committed?**
Yes — `.gitignore` lists it, and `.mcp.json` only ever holds a `${GHL_PIT_TOKEN}` placeholder
rather than the real value. That's what makes this repo safe to share.

**Can I use this for more than one sub-account?**
Yes, in the same chat — see [section 16](#16-working-with-more-than-one-sub-account). No need to
copy the folder or open a new environment per sub-account.

**What if the MCP won't connect?**
You lose nothing important. The `/ghl` skill covers everything and reads `.env` directly. Fix it
whenever: [.claude/mcp-setup.md](.claude/mcp-setup.md).

**Can Claude accidentally message a customer?**
It's instructed to confirm with you before anything outbound — messages, appointments, workflow
enrolment. Those rules are in [CLAUDE.md](CLAUDE.md). Still: read what it proposes before you
approve, especially the first few times.

**Where do I put exported contact lists?**
Anywhere except this folder. It's tooling only, and exports contain personal data.
`.gitignore` blocks the common filenames, but keeping them out entirely is the habit.

**Something's wrong and I can't tell what.**
Run `whoami` and paste the output when you ask for help. It's safe to share — the token is
truncated.

---

## Quick reference card

```
Setup (once)      ./setup.sh                    .\setup.ps1
Start Claude      ./claude-here.sh              .\claude-here.ps1
Test connection   ./.claude/skills/ghl/scripts/ghl.sh whoami
                  .\.claude\skills\ghl\scripts\ghl.ps1 whoami
Check MCP         /mcp            (type this inside Claude)
Load the toolkit  /ghl            (type this inside Claude)

Your two secrets live in .env — never commit it, never share it.
Two roads in, one token: the REST API (default, complete) and the MCP (conversational).
Real CRM, real customers, no undo. Claude asks before anything outbound.
```

**Next:** [CLAUDE.md](CLAUDE.md) for the full rules · [SKILL.md](.claude/skills/ghl/SKILL.md)
for every command · [.claude/mcp-setup.md](.claude/mcp-setup.md) for MCP details.

---

## 16. Working with more than one sub-account

You don't need a separate folder, environment, or chat per sub-account (client, agency
location, whatever you'd call it). One registry file — [accounts.conf](accounts.conf) — lets
one ongoing conversation work with any of them, by name.

### How it works

- The first sub-account you set up (Step 4 above) is the **default** — nothing changes for it.
- Every *additional* sub-account gets: its own Private Integration Token + Location ID (from
  that sub-account, same process as before), saved as two new env vars with a unique suffix,
  and one line in `accounts.conf` giving that pair a short name (an "alias").
- From then on, just say which one you mean — *"for Client A, ..."* — and Claude will use the
  right credentials. No relaunching, no new environment.

### Adding a sub-account

1. In HighLevel, switch into the **new** sub-account → **Settings → Other Settings → Private
   Integrations → Create new Integration** → tick scopes → copy the `pit-...` token.
2. Grab its **Location ID** from that sub-account's **Settings → Business Profile**.
3. Add two new lines wherever your secrets live (your PC's `.env`, or the cloud environment's
   Environment Variables panel) — pick a short, unique suffix for this sub-account, e.g.
   `CLIENTA`:
   ```
   GHL_PIT_TOKEN_CLIENTA=pit-...
   GHL_LOCATION_ID_CLIENTA=...
   ```
4. Open `accounts.conf` and add one line at the bottom:
   ```
   clienta|Client A|GHL_PIT_TOKEN_CLIENTA|GHL_LOCATION_ID_CLIENTA
   ```
   (`clienta` is the alias you'll refer to it by; `Client A` is just a readable name.)
5. That's it — ask a question naming that account, e.g. *"For Client A, list contacts tagged
   hot-lead"*, and Claude will use those credentials for that request.

### A safety note

Claude will never fetch or act on a GHL account's data unless **you named that account in your
message** — not even MVP Ventures, even though it's the "default" one technically. No client
name in your request means Claude asks which one you mean instead of guessing. This is a hard
rule, not a preference — it applies to every read as well as every write, and it applies from
your very first sub-account onward, not just once you have several.

### The one thing that still needs the manual command

The conversational LeadConnector MCP only ever talks to your **default** sub-account — for
every other one, Claude uses the REST API under the hood (via `--account`/`-Account`), which is
the primary road anyway per [section 8](#8-the-two-roads-to-gohighlevel-api-vs-mcp). You don't
need to do anything differently — just keep asking in plain English.

---

## Credit

Base setup adapted from
[shivamviswas/ghl-crm-claude-base-steup](https://github.com/shivamviswas/ghl-crm-claude-base-steup).
