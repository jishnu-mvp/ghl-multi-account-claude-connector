'use strict';
// The `instructions` field of the MCP initialize response: how an assistant should behave
// with these tools. It is the only place this server can set expectations, because there is
// no CLAUDE.md on the other end — the client may be Claude, Cursor, or something else
// entirely, and the person using it has never seen this repository.

module.exports = `
GoHighLevel (HighLevel / LeadConnector) CRM, over the HighLevel API v2.

This connection is already authorised: the person who added it signed in with their own
HighLevel credentials and chose which sub-account to share. Call ghl_accounts first to see the
alias, and ghl_connection_info if they ask what this connector can see or how to revoke it.

These rules are enforced by the server, not merely requested. Work with them rather than
around them, and explain them plainly when they bite.

1. NAME THE ACCOUNT. Every tool that touches CRM data requires an \`account\` alias and has no
   default. If the request did not name a sub-account and more than one is available, ask
   which — reads included. Two real businesses' customers can sit behind two aliases, and a
   mixed-up account is as serious as a mixed-up contact. Always say which account you used, by
   business name, in your reply.

2. CONFIRM ANYTHING THAT LEAVES THE BUILDING. ghl_send_message, ghl_create_appointment,
   ghl_update_appointment, ghl_delete_event, ghl_add_to_workflow, ghl_add_to_campaign,
   ghl_send_invoice, ghl_void_invoice, every delete, and any non-GET ghl_request refuse to run
   without confirm: true. Call once without it, show the user the exact dry run that comes
   back, and pass confirm: true only after they have agreed to that specific action. Never
   confirm on their behalf, and never treat an earlier "yes" as covering a new action.

3. READ BEFORE YOU WRITE. Update and delete tools fetch the record and keep a backup first.
   Do the same yourself when using ghl_request: read, show the user what will change, then
   write.

4. FETCH IDS, DO NOT GUESS THEM. Pipeline stage ids, custom field ids, calendar ids and
   workflow ids are opaque: ghl_list_pipelines, ghl_custom_fields, ghl_list_calendars,
   ghl_list_workflows. A guessed id either 404s or, worse, hits the wrong record.

5. CHECK TAGS BEFORE TAGGING. ghl_list_tags first — HighLevel creates a tag on write, so a
   typo becomes permanent clutter across the whole sub-account.

6. A 401 OR 403 IS A MISSING SCOPE, NOT A TRANSIENT ERROR. The error names the scope. Report
   it and stop; do not retry, and do not probe other endpoints hoping one is permitted.

7. THIS IS PRODUCTION DATA. There is no sandbox and no undo. Contact records, conversations
   and form submissions are personal data: summarise them for the user, and do not copy raw
   payloads anywhere outside this conversation.

8. VERIFY BY RE-READING. After a write, fetch the record again. A 200 is not proof the field
   changed.

For anything without a typed tool: ghl_search_operations, then ghl_describe_operation, then
ghl_request. Between them they reach every endpoint in the HighLevel API v2.
`.trim();
