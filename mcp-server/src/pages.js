'use strict';
// The login pages, rendered as self-contained HTML — no external stylesheets, fonts or
// scripts, so the page works offline and cannot leak the credential being typed into it.

const config = require('./config');

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --ink:#14171f; --muted:#5b6472;
        --line:#e2e6ec; --accent:#1f6feb; --accent-ink:#fff; --warn-bg:#fff6e5; --warn-line:#f0c069;
        --err-bg:#fdecec; --err-line:#e08f8f; --ok:#127a3d; --code:#f1f3f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --card:#171a21; --ink:#e8ebf0; --muted:#9aa4b2; --line:#2a3038;
          --accent:#4c8dff; --warn-bg:#2a2213; --warn-line:#6b5322; --err-bg:#2a1717;
          --err-line:#6b2c2c; --ok:#4ec97f; --code:#11141a; }
}
* { box-sizing:border-box; }
body { margin:0; padding:32px 16px 64px; background:var(--bg); color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width:660px; margin:0 auto; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; margin-bottom:20px; }
h1 { font-size:22px; margin:0 0 6px; letter-spacing:-0.01em; }
h2 { font-size:16px; margin:28px 0 10px; }
p { margin:0 0 14px; color:var(--muted); }
p.lead { color:var(--ink); }
label { display:block; font-weight:600; font-size:13px; margin:16px 0 6px; }
.hint { font-weight:400; color:var(--muted); font-size:12.5px; margin-top:4px; }
input[type=text], input[type=password] { width:100%; padding:10px 12px; font-size:14px; font-family:inherit;
  border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
button, .btn { display:inline-block; margin-top:20px; padding:11px 18px; font-size:14px; font-weight:600;
  font-family:inherit; border:0; border-radius:8px; background:var(--accent); color:var(--accent-ink);
  cursor:pointer; text-decoration:none; }
button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
.note, .error { padding:12px 14px; border-radius:8px; font-size:13.5px; margin:0 0 18px; }
.note { background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--ink); }
.error { background:var(--err-bg); border:1px solid var(--err-line); color:var(--ink); }
code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
code { background:var(--code); padding:1px 5px; border-radius:4px; }
pre { background:var(--code); padding:12px 14px; border-radius:8px; overflow-x:auto; border:1px solid var(--line); }
ol, ul { color:var(--muted); padding-left:22px; margin:0 0 14px; }
li { margin-bottom:6px; }
hr { border:0; border-top:1px solid var(--line); margin:26px 0; }
details { margin-top:20px; }
summary { cursor:pointer; font-weight:600; font-size:14px; }
table { width:100%; border-collapse:collapse; margin:8px 0 0; font-size:13.5px; }
td { padding:7px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
td:first-child { color:var(--muted); width:38%; }
.ok { color:var(--ok); font-weight:600; }
.radio { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line);
  border-radius:8px; margin-bottom:8px; cursor:pointer; }
.radio input { margin-top:3px; }
.small { font-size:12.5px; color:var(--muted); }
`;

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · GoHighLevel connector</title>
<style>${STYLE}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

/** Step 1: pick an authentication method and hand over the credential. */
function loginPage(session, { oauthApp, error, form = {}, needLocation = false } = {}) {
  const alias = esc(form.alias || session.alias || '');
  const displayName = esc(form.displayName || session.displayName || '');
  const locationId = esc(form.locationId || '');
  const k = esc(session.key);

  const oauthBlock = oauthApp
    ? `<h2>Log in with HighLevel</h2>
       <p>Sign in with your HighLevel email and password on HighLevel's own site, then choose the
          sub-account to connect. Your password never touches this machine.</p>
       <form method="get" action="/oauth/start">
         <input type="hidden" name="k" value="${k}">
         <label for="oalias">Short name for this connection</label>
         <input id="oalias" type="text" name="alias" value="${alias}" placeholder="kellixiq" autocomplete="off">
         <div class="hint">Not used by the OAuth form itself — set it in the box above before continuing if you want a specific alias.</div>
         <button type="submit">Log in with HighLevel →</button>
       </form>
       <p class="small">Marketplace app in use: <code>${esc(oauthApp.clientId.slice(0, 10))}…</code> (${esc(oauthApp.source)})</p>`
    : `<details>
         <summary>Or set up “Log in with HighLevel” (email + password sign-in)</summary>
         <p style="margin-top:12px">HighLevel only allows password sign-in through a marketplace app, and it has no
            way for an app to register itself — so this needs a one-time, three-minute setup by
            whoever owns the HighLevel agency:</p>
         <ol>
           <li>Open <code>${esc(config.MARKETPLACE_BASE_URL)}</code> and sign in as the agency.</li>
           <li><strong>My Apps → Create App</strong>. Distribution type <em>Sub-Account</em> (or both).</li>
           <li>Add this exact redirect URL:
             <pre>http://127.0.0.1:${esc(session.port)}/oauth/callback</pre>
             <span class="small">The port changes each login. Add <code>http://127.0.0.1</code> ports you plan to
             use, or set <code>GHL_MCP_LOGIN_PORT</code> to pin one.</span></li>
           <li>Tick the same scopes you would tick on a Private Integration, then copy the
               <strong>Client ID</strong> and <strong>Client Secret</strong> in below.</li>
         </ol>
         <form method="post" action="/oauth/app?k=${k}">
           <label for="clientId">Client ID</label>
           <input id="clientId" type="text" name="clientId" autocomplete="off" spellcheck="false">
           <label for="clientSecret">Client Secret</label>
           <input id="clientSecret" type="password" name="clientSecret" autocomplete="off">
           <label for="oalias2">Short name for this connection</label>
           <input id="oalias2" type="text" name="alias" value="${alias}" placeholder="kellixiq" autocomplete="off">
           <button type="submit">Save app and log in →</button>
         </form>
         <p class="small">Stored only in <code>${esc(config.credentialsFile())}</code> on this machine.</p>
       </details>`;

  return shell('Connect a sub-account', `
<div class="card">
  <h1>Connect a GoHighLevel sub-account</h1>
  <p class="lead">This page runs on your own machine (<code>127.0.0.1</code>) and is only reachable from it.
     What you type here is saved to <code>${esc(config.credentialsFile())}</code> — never into the
     repository, and never into the chat.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ''}

  <h2>Private Integration Token</h2>
  <p>In HighLevel: <strong>Settings → Other Settings → Private Integrations → Create new
     Integration</strong>, tick the scopes you need, copy the <code>pit-…</code> token. It is shown once.</p>
  <form method="post" action="/pit?k=${k}" autocomplete="off">
    <label for="token">Private Integration Token</label>
    <input id="token" type="password" name="token" placeholder="pit-…" autocomplete="off" spellcheck="false" required>

    <label for="alias">Short name for this connection <span class="hint">— what you will call it in chat</span></label>
    <input id="alias" type="text" name="alias" value="${alias}" placeholder="kellixiq" autocomplete="off" required>

    <label for="displayName">Business name <span class="hint">— optional; detected from HighLevel if left blank</span></label>
    <input id="displayName" type="text" name="displayName" value="${displayName}" placeholder="Kellix iQ" autocomplete="off">

    <label for="locationId">Location ID ${needLocation ? '' : '<span class="hint">— optional; Settings → Business Profile</span>'}</label>
    <input id="locationId" type="text" name="locationId" value="${locationId}" placeholder="e.g. ve9EPM428h8vShlRW1KT" autocomplete="off"
      ${needLocation ? 'required' : ''}>
    <div class="hint">Leave blank and we will try to detect it. Agency-level tokens get a picker.</div>

    <button type="submit">Connect</button>
  </form>

  <hr>
  ${oauthBlock}
</div>
<p class="small">You can close this tab once it says connected. The page expires
   ${Math.round(config.LOGIN_SERVER.ttlMs / 60000)} minutes after it was opened.</p>`);
}

/** Step 2 (sometimes): choose which sub-account this connection points at. */
function locationPickerPage(session, { locations = [], action, heading, note, allowManual = false }) {
  const options = locations.length
    ? locations.map((l, i) => `
        <label class="radio">
          <input type="radio" name="locationId" value="${esc(l.id)}" ${i === 0 ? 'checked' : ''}>
          <span><strong>${esc(l.name || l.id)}</strong><br><span class="small">${esc(l.id)}</span></span>
        </label>`).join('')
    : '';

  const manual = (allowManual || !locations.length)
    ? `<label for="manual">${locations.length ? 'Or paste a Location ID' : 'Location ID'}</label>
       <input id="manual" type="text" name="locationId" placeholder="Settings → Business Profile" autocomplete="off"
         ${locations.length ? '' : 'required'}>`
    : '';

  return shell(heading, `
<div class="card">
  <h1>${esc(heading)}</h1>
  ${note ? `<p class="lead">${esc(note)}</p>` : ''}
  <form method="post" action="${esc(action)}">
    ${options}
    ${manual}
    <button type="submit">Connect this sub-account</button>
  </form>
</div>`);
}

function successPage(account, location) {
  return shell('Connected', `
<div class="card">
  <h1><span class="ok">✓</span> Connected</h1>
  <p class="lead">Go back to your Claude session and carry on — it can use this sub-account now.
     Nothing else to set up.</p>
  <table>
    <tr><td>Refer to it as</td><td><code>${esc(account.alias)}</code></td></tr>
    <tr><td>Business</td><td>${esc((location && location.name) || account.displayName)}</td></tr>
    <tr><td>Sub-account (location) id</td><td><code>${esc(account.locationId || '—')}</code></td></tr>
    <tr><td>Signed in with</td><td>${account.authType === 'oauth' ? 'HighLevel login (OAuth)' : 'Private Integration Token'}</td></tr>
    ${account.expiresAt ? `<tr><td>Access token expires</td><td>${esc(new Date(account.expiresAt).toISOString())} <span class="small">(refreshed automatically)</span></td></tr>` : ''}
  </table>
  <p class="small" style="margin-top:18px">Saved to <code>${esc(config.credentialsFile())}</code>, readable only by you.
     Revoke any time by deleting the Private Integration in HighLevel, or with the <code>ghl_logout</code> tool.</p>
</div>`);
}

function errorPage(title, detail) {
  return shell(title, `
<div class="card">
  <h1>${esc(title)}</h1>
  <div class="error">${esc(detail)}</div>
  <p>Nothing was saved. Close this tab and start again with <code>ghl_login</code>.</p>
</div>`);
}

module.exports = { loginPage, locationPickerPage, successPage, errorPage, shell, esc };
