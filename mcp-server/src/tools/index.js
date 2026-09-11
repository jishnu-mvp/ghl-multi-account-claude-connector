/*
 * GHL Multi-Account Claude Connector
 * Copyright (c) 2026 Jishnu Venugopal. All Rights Reserved.
 *
 * Proprietary software. You may use this software as-is for your own
 * GoHighLevel account(s). You may NOT copy, redistribute, or use this
 * code (or any part of it) to build a new or competing product without
 * the owner's prior written permission. See LICENSE and NOTICE at the
 * repository root for full terms. This notice must not be removed.
 * Contact: jishhnnuu@gmail.com
 */

'use strict';
// Everything the server exposes, in the order it should be read.
//
// Two deployments, one tool layer. The only difference is the session tools: locally you log
// in from inside the conversation, whereas on the hosted server the OAuth grant already
// settled which account the caller may touch, so there is nothing to log in to.

const DOMAIN_TOOLS = [
  ...require('./contacts'),       // contacts, tags, notes, tasks
  ...require('./conversations'),  // conversations and messaging
  ...require('./opportunities'),  // pipelines and opportunities
  ...require('./calendars'),      // calendars, slots, appointments
  ...require('./automation'),     // workflows and campaigns
  ...require('./location'),       // sub-account config, forms, surveys, users
  ...require('./commerce'),       // products, invoices, payments
  ...require('./content'),        // funnels, links, businesses, media, blogs, social
  ...require('./raw'),            // catalogue + escape hatch
];

const SESSION_TOOLS = {
  local: require('./session'),          // ghl_login, ghl_login_status, ghl_accounts, ghl_logout…
  remote: require('./remote-session'),  // ghl_accounts, ghl_whoami, ghl_connection_info
};

// A duplicate name would silently shadow a tool, so fail loudly at startup instead.
function assertUnique(tools) {
  const seen = new Set();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}

// GHL_MCP_TOOLSET=core trims the inventory to the everyday surface for anyone who would
// rather spend less of the model's context on tool schemas. Nothing is lost: the trimmed
// tools are all still reachable through ghl_search_operations + ghl_request.
const CORE = new Set([
  'ghl_login', 'ghl_login_status', 'ghl_login_config', 'ghl_accounts', 'ghl_whoami', 'ghl_logout',
  'ghl_connection_info',
  'ghl_list_contacts', 'ghl_search_contacts', 'ghl_get_contact', 'ghl_create_contact',
  'ghl_update_contact', 'ghl_add_tags', 'ghl_remove_tags', 'ghl_add_note', 'ghl_contact_notes',
  'ghl_list_conversations', 'ghl_conversation_messages', 'ghl_send_message',
  'ghl_list_pipelines', 'ghl_search_opportunities', 'ghl_get_opportunity', 'ghl_update_opportunity',
  'ghl_list_calendars', 'ghl_free_slots', 'ghl_list_events', 'ghl_create_appointment',
  'ghl_list_workflows', 'ghl_add_to_workflow',
  'ghl_custom_fields', 'ghl_list_tags', 'ghl_list_users', 'ghl_get_location',
  'ghl_search_operations', 'ghl_describe_operation', 'ghl_request',
]);

/**
 * @param {'local'|'remote'} mode  which session tools to include
 * @param {string} [toolset]       'core' to trim, anything else for the full set
 */
function buildTools(mode = 'local', toolset = process.env.GHL_MCP_TOOLSET) {
  const session = SESSION_TOOLS[mode];
  if (!session) throw new Error(`Unknown tool mode: ${mode}`);
  const tools = assertUnique([...session, ...DOMAIN_TOOLS]);
  return String(toolset || 'full').toLowerCase() === 'core'
    ? tools.filter((t) => CORE.has(t.name))
    : tools;
}

module.exports = { buildTools, CORE };
