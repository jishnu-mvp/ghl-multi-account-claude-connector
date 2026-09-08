#!/usr/bin/env node
'use strict';
// GoHighLevel MCP server — entry point.
//
//   node server.js            speak MCP over stdio (how Claude Code runs it)
//   node server.js --login    open the browser login and wait, with no chat involved
//   node server.js --list     print the tool inventory
//
// No dependencies, no build step, no .env: whoever uses it logs in through the browser.

// A closed pipe (`node server.js --list | head`) is not an error worth crashing over.
process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') process.exit(0); });

const config = require('./src/config');
const { McpServer, serve } = require('./src/mcp');
const { buildTools } = require('./src/tools');

const tools = buildTools('local');

const INSTRUCTIONS = `
GoHighLevel (HighLevel / LeadConnector) CRM over the HighLevel API v2.

Authentication is per person: call ghl_login and give the user the link it returns. They log in
in their own browser — with their HighLevel Private Integration Token, or their HighLevel email
and password where the OAuth app is set up — and the credential is stored on their machine,
never in this repository and never in the chat. There is nothing to configure first.

Rules this server enforces, and you should respect in how you talk about them:

1. Every tool that touches CRM data needs an explicit \`account\` alias. There is NO default.
   If the user's request did not name a sub-account, ask which one before calling anything —
   reads included. Two real businesses' customers can sit behind two aliases. Use ghl_accounts
   to see them, and always say which one you used, by business name, in your reply.
2. Anything that reaches a real person (ghl_send_message, ghl_create_appointment,
   ghl_add_to_workflow, ghl_add_to_campaign, ghl_send_invoice) or destroys data refuses to run
   without confirm: true. Call it once without confirm, show the user the dry run it returns,
   and only pass confirm: true after they say yes. Never confirm on their behalf.
3. Read before you write. Update and delete tools fetch and back up the record first; keep
   doing the same when you use ghl_request.
4. Fetch ids, never guess them: ghl_list_pipelines for stage ids, ghl_custom_fields for field
   ids, ghl_list_calendars, ghl_list_workflows, ghl_list_tags.
5. Check ghl_list_tags before tagging — HighLevel creates a tag on write, so a typo becomes
   permanent clutter.
6. A 401 or 403 means a missing scope. Report which scope to add and stop; do not retry and do
   not probe other endpoints.
7. This is production CRM data with no sandbox and no undo. Contact records, conversations and
   form submissions are personal data — summarise them, and never paste raw payloads into
   commits, tickets or anywhere outside this conversation.

For anything without a typed tool: ghl_search_operations, then ghl_describe_operation, then
ghl_request. That covers the whole API v2 surface.
`.trim();

function build() {
  return new McpServer({
    name: config.SERVER_NAME,
    version: config.SERVER_VERSION,
    instructions: INSTRUCTIONS,
  }).registerTools(tools);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'GoHighLevel MCP server',
      '',
      '  node server.js           speak MCP over stdio (what Claude Code does)',
      '  node server.js --login   log in to a sub-account in the browser',
      '  node server.js --list    list the tools this server exposes',
      '',
      `Credentials: ${config.credentialsFile()}`,
      '',
    ].join('\n'));
    return;
  }

  if (args.includes('--list')) {
    const server = build();
    const list = server.listTools();
    process.stdout.write(`${list.length} tools:\n`);
    for (const t of list) {
      process.stdout.write(`  ${t.name.padEnd(32)} ${t.description.split('\n')[0].slice(0, 100)}\n`);
    }
    return;
  }

  if (args.includes('--login')) {
    // Standalone login: no MCP client needed, so someone can connect an account before they
    // ever open a chat.
    const login = require('./src/login');
    const aliasIndex = args.indexOf('--account');
    const alias = aliasIndex !== -1 ? args[aliasIndex + 1] : undefined;
    const session = await login.start({ alias });
    process.stdout.write(`\nOpen this link to connect a GoHighLevel sub-account:\n\n    ${session.url}\n\n`);
    await login.openBrowser(session.url);
    process.stdout.write('Waiting for the login to finish (Ctrl-C to give up)…\n');
    await login.waitFor(session, config.LOGIN_SERVER.ttlMs);
    const summary = session.summary();
    if (summary.status === 'complete') {
      process.stdout.write(`\nConnected "${summary.result.alias}" — ${summary.result.displayName} (location ${summary.result.locationId}).\n`);
      process.stdout.write(`Saved to ${config.credentialsFile()}\n\n`);
    } else {
      process.stdout.write(`\nLogin did not complete (${summary.status}${summary.error ? `: ${summary.error}` : ''}).\n\n`);
      process.exitCode = 1;
    }
    session.close();
    return;
  }

  // Default: MCP over stdio. Nothing but protocol frames may reach stdout from here on.
  serve(build());
  process.stderr.write(`[ghl-mcp] ready — ${tools.length} tools, credentials at ${config.credentialsFile()}\n`);
}

// Exported so the self-test drives the same server the client gets, instructions included.
module.exports = { build, INSTRUCTIONS };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[ghl-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
