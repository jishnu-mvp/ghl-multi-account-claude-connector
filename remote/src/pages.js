'use strict';
// The pages a person actually sees: the consent-and-connect screen, the sub-account picker,
// the "you're connected" screen, and the landing page.
//
// Self-contained HTML — no external stylesheet, font or script — so a credential typed here
// cannot leak to a third party, and the page still renders behind a strict CSP.

const config = require('./config');

const STYLE = `
:root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --ink:#14171f; --muted:#5b6472;
        --line:#e3e7ec; --accent:#1f6feb; --accent-ink:#fff; --warn-bg:#fff7e6; --warn-line:#efc775;
        --err-bg:#fdecec; --err-line:#e29494; --ok:#12793d; --code:#f1f3f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --card:#171a21; --ink:#e8ebf0; --muted:#9aa4b2; --line:#2a3038;
          --accent:#4c8dff; --warn-bg:#2a2213; --warn-line:#6b5322; --err-bg:#2a1717;
          --err-line:#6b2c2c; --ok:#4ec97f; --code:#11141a; }
}
* { box-sizing:border-box; }
body { margin:0; padding:36px 16px 72px; background:var(--bg); color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width:640px; margin:0 auto; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:30px; margin-bottom:20px; }
h1 { font-size:22px; margin:0 0 8px; letter-spacing:-0.01em; }
h2 { font-size:15px; margin:26px 0 10px; }
p { margin:0 0 14px; color:var(--muted); }
p.lead { color:var(--ink); }
label { display:block; font-weight:600; font-size:13px; margin:16px 0 6px; }
.hint { font-weight:400; color:var(--muted); font-size:12.5px; margin-top:4px; }
input[type=text], input[type=password] { width:100%; padding:10px 12px; font-size:14px; font-family:inherit;
  border:1px solid var(--line); border-radius:9px; background:var(--bg); color:var(--ink); }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
button, .btn { display:inline-block; margin-top:20px; padding:12px 20px; font-size:14px; font-weight:600;
  font-family:inherit; border:0; border-radius:9px; background:var(--accent); color:var(--accent-ink);
  cursor:pointer; text-decoration:none; }
button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
button.wide { width:100%; }
.note, .error { padding:12px 14px; border-radius:9px; font-size:13.5px; margin:0 0 18px; }
.note { background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--ink); }
.error { background:var(--err-bg); border:1px solid var(--err-line); color:var(--ink); }
code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
code { background:var(--code); padding:1px 5px; border-radius:4px; }
pre { background:var(--code); padding:12px 14px; border-radius:9px; overflow-x:auto; border:1px solid var(--line); }
ul, ol { color:var(--muted); padding-left:22px; margin:0 0 14px; }
li { margin-bottom:6px; }
hr { border:0; border-top:1px solid var(--line); margin:26px 0; }
details { margin-top:18px; }
summary { cursor:pointer; font-weight:600; font-size:14px; }
table { width:100%; border-collapse:collapse; margin:6px 0 0; font-size:13.5px; }
td { padding:7px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
td:first-child { color:var(--muted); width:40%; }
.client { display:flex; gap:12px; align-items:center; padding:14px; border:1px solid var(--line);
  border-radius:10px; background:var(--bg); margin-bottom:18px; }
.client .who { font-weight:600; }
.pick { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line);
  border-radius:9px; margin-bottom:6px; cursor:pointer; background:var(--bg); }
.pick input { margin-top:3px; width:16px; height:16px; }
.pick .name { font-weight:600; }
.crm { font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted);
  margin:22px 0 8px; font-weight:700; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.count { font-weight:600; color:var(--ink); }
.ok { color:var(--ok); font-weight:600; }
.small { font-size:12.5px; color:var(--muted); }
.foot { text-align:center; }
.foot a { color:var(--muted); }
`;

/** "1 sub-account" / "3 sub-accounts" — these pages are read by clients, not by a log. */
function plural(n, singular, suffix = 's') {
  return `${n} ${singular}${n === 1 ? '' : suffix}`;
}

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(title, body) {
  const brand = config.BRAND;
  const footer = [
    brand.supportEmail ? `<a href="mailto:${esc(brand.supportEmail)}">Support</a>` : null,
    brand.privacyUrl ? `<a href="${esc(brand.privacyUrl)}">Privacy</a>` : null,
    brand.termsUrl ? `<a href="${esc(brand.termsUrl)}">Terms</a>` : null,
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(brand.name)}</title>
<style>${STYLE}</style></head>
<body><div class="wrap">${body}
${footer ? `<p class="small foot">${footer}</p>` : ''}
${brand.operator ? `<p class="small foot">Operated by ${esc(brand.operator)}</p>` : ''}
</div></body></html>`;
}

/**
 * The one screen that matters: it names the client asking for access, and connects a
 * GoHighLevel account. Consent and connection are the same act — nothing is granted until
 * the person picks a sub-account here.
 */
function consentPage({ session, client, oauthAvailable, tokenAllowed = false, error, form = {}, needLocation = false }) {
  const k = esc(session.key);
  const clientName = esc(client.client_name);
  const clientHost = client.client_uri ? safeHost(client.client_uri) : null;

  const oauthBlock = oauthAvailable
    ? `<form method="post" action="/oauth/connect/highlevel?k=${k}">
         <button type="submit" class="wide">Sign in with HighLevel →</button>
       </form>
       <p class="small">You sign in on HighLevel's own site — this server never sees your password.
          Then you choose which sub-accounts to share.</p>`
    : `<div class="note">Signing in with a HighLevel account is not available on this server yet.
          ${tokenAllowed ? 'Use a Private Integration Token below.' : 'The operator needs to add the HighLevel app credentials before anyone can connect.'}</div>`;

  const tokenBlock = tokenAllowed
    ? `<hr>
       <h2>Or connect with a Private Integration Token</h2>
       <p>In HighLevel: <strong>Settings → Other Settings → Private Integrations → Create new
          Integration</strong>, tick the scopes you want to allow, copy the <code>pit-…</code> token.
          It is shown once. This route covers one sub-account at a time.</p>
       <form method="post" action="/oauth/connect/token?k=${k}" autocomplete="off">
         <label for="token">Private Integration Token</label>
         <input id="token" type="password" name="token" placeholder="pit-…" autocomplete="off" spellcheck="false" required>

         <label for="locationId">Location ID ${needLocation ? '' : '<span class="hint">— optional; Settings → Business Profile</span>'}</label>
         <input id="locationId" type="text" name="locationId" value="${esc(form.locationId)}"
           placeholder="e.g. ve9EPM428h8vShlRW1KT" autocomplete="off" ${needLocation ? 'required' : ''}>
         <div class="hint">Leave blank to have it detected. An agency-level token gets a picker.</div>
         ${config.SIGNUP_PASSCODE ? `
         <label for="passcode">Access phrase</label>
         <input id="passcode" type="password" name="passcode" autocomplete="off" required>
         <div class="hint">This server is not open to the public — the operator gave you a phrase.</div>` : ''}

         <button type="submit">Connect</button>
       </form>`
    : '';

  return shell('Authorise access', `
<div class="card">
  <h1>Connect your CRM to ${clientName}</h1>

  <div class="client">
    <div>
      <div class="who">${clientName}</div>
      <div class="small">${clientHost ? `${esc(clientHost)} · ` : ''}is asking to read and write your GoHighLevel data through ${esc(config.BRAND.name)}.</div>
    </div>
  </div>

  ${error ? `<div class="error">${esc(error)}</div>` : ''}

  <p class="lead">Once connected, ${clientName} can look up contacts, read conversations, manage
     opportunities, calendars and invoices — and it must ask you before anything leaves the
     building: sending a message, booking an appointment, enrolling someone in a workflow or
     deleting a record all require your explicit go-ahead each time.</p>

  ${oauthBlock}
  ${tokenBlock}

  <p class="small">Your credentials are encrypted before they are stored, are never shown to
     ${clientName}, and are never written into a conversation. Revoke access any time by
     uninstalling the app in HighLevel, or by removing this connector.</p>
</div>`);
}

/**
 * The sub-account checklist for the CRM just signed into. Multi-select, with "Add all" as a
 * second submit button — a script would be tidier, but the page runs under a CSP that forbids
 * one, and a server-side select-all needs no JavaScript at all.
 */
function subAccountPickerPage({ session, crmName, locations = [], alreadyConnected = [], listingFailed = null }) {
  const k = esc(session.key);
  const action = `/oauth/connect/select?k=${k}`;

  const boxes = locations.map((l) => `
    <label class="pick">
      <input type="checkbox" name="locationId" value="${esc(l.id)}">
      <span><span class="name">${esc(l.name)}</span><br><span class="small">${esc(l.id)}</span></span>
    </label>`).join('');

  const hiddenAll = locations.map((l) => `<input type="hidden" name="locationId" value="${esc(l.id)}">`).join('');
  const priorCrms = [...new Set(alreadyConnected.map((c) => c.companyName || 'another CRM'))];

  return shell('Choose sub-accounts', `
<div class="card">
  <h1>Which sub-accounts?</h1>
  <p class="lead">Signed in to ${crmName ? `<strong>${esc(crmName)}</strong>` : 'your HighLevel account'}.
     Tick the sub-accounts this assistant should be able to work with.</p>

  ${alreadyConnected.length ? `<div class="note">Already added:
     <span class="count">${plural(alreadyConnected.length, 'sub-account')}</span> from
     ${esc(priorCrms.join(', '))}. Anything you tick here is added to those.</div>` : ''}

  ${listingFailed ? `<div class="note">HighLevel would not list the sub-accounts for this account
     (${esc(listingFailed)}). You can still add one by pasting its Location ID below.</div>` : ''}

  ${locations.length ? `
  <form method="post" action="${action}">
    ${boxes}
    <div class="row"><button type="submit">Add ticked sub-accounts</button></div>
  </form>

  <form method="post" action="${action}">
    ${hiddenAll}
    <div class="row"><button type="submit" class="secondary">Add all ${locations.length}</button></div>
  </form>` : ''}

  <form method="post" action="${action}">
    <label for="manual">${locations.length ? 'Or add one by Location ID' : 'Location ID'}</label>
    <input id="manual" type="text" name="locationId" placeholder="Settings → Business Profile"
      autocomplete="off" ${locations.length ? '' : 'required'}>
    <button type="submit" class="secondary">Add this one</button>
  </form>

  <p class="small">Only sub-accounts your own HighLevel account covers appear here.</p>
</div>`);
}

/**
 * What is attached so far, and the way forward. Nothing reaches the assistant until Finish,
 * which is what makes several CRMs possible in one connection.
 *
 * The second-CRM option is deliberately proportional. Most people work in one HighLevel
 * account and asking them about a second one is noise that makes a finished connection look
 * unfinished — so Finish is the only thing presented, and the option to add another agency
 * sits behind a closed <details> (native HTML: the strict CSP here forbids script). Someone
 * who has already added two CRMs has shown that is how they work, so for them it stays open.
 */
function reviewPage({ session, connected = [], failed = [] }) {
  const k = esc(session.key);

  // Grouped by CRM, so it is obvious which agency each sub-account came from.
  const byCrm = new Map();
  for (const item of connected) {
    const crm = item.companyName || 'Sub-account sign-in';
    if (!byCrm.has(crm)) byCrm.set(crm, []);
    byCrm.get(crm).push(item);
  }
  const several = byCrm.size > 1;

  const row = (item, crm) => `<div class="pick"><span><span class="name">${esc(item.displayName)}</span><br>
    <span class="small">${crm ? `${esc(crm)} · ` : ''}say &ldquo;${esc(item.alias)}&rdquo; · ${esc(item.locationId || '—')}</span></span></div>`;

  // One sub-account needs no grouping: the heading already names the business, so the CRM
  // goes on the same line as the alias rather than getting a section header of its own.
  const groups = connected.length === 1
    ? row(connected[0], [...byCrm.keys()][0])
    : [...byCrm.entries()].map(([crm, items]) => `
        <div class="crm">${esc(crm)} — ${plural(items.length, 'sub-account')}</div>
        ${items.map((i) => row(i, null)).join('')}
      `).join('');

  const heading = connected.length === 1
    ? `${esc(connected[0].displayName)} is ready`
    : `${plural(connected.length, 'sub-account')} ready`;

  return shell('Review connection', `
<div class="card">
  <h1><span class="ok">✓</span> ${heading}</h1>

  ${failed.length ? `<div class="note">${failed.length} could not be added:
     ${esc(failed.map((f) => `${f.locationId} (${f.reason})`).join(' · '))}</div>` : ''}

  ${groups}

  <form method="post" action="/oauth/connect/finish?k=${k}">
    <button type="submit" class="wide">Finish and return to the assistant</button>
  </form>
  <p class="small">Nothing is shared with the assistant until you finish.${connected.length > 1
    ? ' Afterwards, name the sub-account when you ask for something — it will not guess between them.'
    : ''}</p>

  <details${several ? ' open' : ''}>
    <summary>${several ? 'Add another HighLevel account?' : 'Work in a second HighLevel account?'}</summary>
    <p>Sign in to that HighLevel agency as well and its sub-accounts join this same connection,
       rather than replacing what is above.${several ? '' : ' Most people never need this.'}</p>
    <form method="post" action="/oauth/connect/highlevel?k=${k}">
      <button type="submit" class="secondary">Sign in to another CRM →</button>
    </form>
  </details>
</div>`);
}

function connectedPage({ tenant, clientName }) {
  return shell('Connected', `
<div class="card">
  <h1><span class="ok">✓</span> Connected</h1>
  <p class="lead">${esc(clientName)} can now work with this GoHighLevel sub-account. You can close
     this window and go back to it.</p>
  <table>
    <tr><td>Sub-account</td><td>${esc(tenant.displayName)}</td></tr>
    <tr><td>Refer to it as</td><td><code>${esc(tenant.alias)}</code></td></tr>
    <tr><td>Location id</td><td><code>${esc(tenant.locationId || '—')}</code></td></tr>
    <tr><td>Authorised with</td><td>${tenant.authType === 'oauth' ? 'HighLevel sign-in' : 'Private Integration Token'}</td></tr>
  </table>
</div>`);
}

function errorPage(title, detail, { retryUrl } = {}) {
  return shell(title, `
<div class="card">
  <h1>${esc(title)}</h1>
  <div class="error">${esc(detail)}</div>
  <p>Nothing was connected and nothing was stored.</p>
  ${retryUrl ? `<a class="btn" href="${esc(retryUrl)}">Try again</a>` : ''}
</div>`);
}

/** The landing page — what someone sees if they open the server URL in a browser. */
function landingPage({ oauthAvailable, toolCount }) {
  return shell('Overview', `
<div class="card">
  <h1>${esc(config.BRAND.name)}</h1>
  <p class="lead">A hosted connector that lets an AI assistant work with your GoHighLevel
     sub-account. Add it once, authorise it with your own HighLevel credentials, and ask for what
     you want in plain English.</p>

  <h2>Add it to your assistant</h2>
  <p>Wherever custom connectors (MCP servers) are added, paste this URL:</p>
  <pre>${esc(config.RESOURCE)}</pre>
  <p>You will be sent here to sign in and choose a sub-account. Nothing to install, and no API
     keys to copy around.</p>

  <h2>What it can do</h2>
  <p>${toolCount} tools across contacts, tags, notes and tasks, conversations and messaging,
     opportunities and pipelines, calendars and appointments, workflows and campaigns, forms,
     surveys, custom fields, users, products, invoices, payments, media and content — plus a
     catalogue covering the rest of the HighLevel API.</p>

  <h2>What it will not do without asking you</h2>
  <ul>
    <li>send an SMS, email or any message to a contact</li>
    <li>book, reschedule or cancel an appointment</li>
    <li>enrol a contact in a workflow or campaign</li>
    <li>send or void an invoice</li>
    <li>delete a contact, opportunity, note or calendar event</li>
  </ul>
  <p>Each of those returns the exact request for you to approve first, every single time.</p>

  <h2>How your credentials are held</h2>
  <ul>
    <li>${oauthAvailable ? 'You sign in on HighLevel\'s own site, or paste a Private Integration Token you created.' : 'You paste a Private Integration Token you created in your own HighLevel account.'}</li>
    <li>It is encrypted before being stored, and is never revealed to the assistant or written into a conversation.</li>
    <li>Access tokens issued to the assistant are short-lived and only valid for this server.</li>
    <li>Revoke any time in HighLevel, or by removing the connector.</li>
  </ul>
  <p class="small">Not affiliated with or endorsed by HighLevel. Uses the public HighLevel API v2
     with the permissions you grant.</p>
</div>`);
}

function safeHost(uri) {
  try { return new URL(uri).host; } catch (_) { return null; }
}

module.exports = { consentPage, subAccountPickerPage, reviewPage, connectedPage, errorPage, landingPage, shell, esc };
