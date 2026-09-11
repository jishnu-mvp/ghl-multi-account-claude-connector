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
// The full HighLevel API v2 endpoint catalogue carried by this repo's /ghl skill.
//
// The typed tools cover everyday work; this table is how the rest of the API stays reachable.
// ghl_search_operations finds an endpoint, ghl_describe_operation explains how to call it, and
// ghl_request performs it — the same discover-then-execute shape the LeadConnector MCP uses,
// but over the complete REST surface.
//
// `loc` says how the sub-account id has to be supplied, which is the trap that produces most
// mystery 4xx responses:
//   q      -> query ?locationId=
//   q_snake-> query ?location_id=      (opportunities search only)
//   alt    -> query ?altId=<location>&altType=location  (invoices, payments, media)
//   path   -> a path segment
//   body   -> a field in the request body
//   none   -> not needed
//   agency -> needs an agency-level credential; a sub-account token gets 401/403

const OPERATIONS = [
  // --- contacts ---
  ['GET', '/contacts/', 'List or keyword-search contacts', 'q', 'contacts'],
  ['POST', '/contacts/search', 'Filtered/sorted contact search (filters, sort, page, pageLimit)', 'body', 'contacts'],
  ['GET', '/contacts/{contactId}', 'Get one contact', 'none', 'contacts'],
  ['POST', '/contacts/', 'Create a contact', 'body', 'contacts'],
  ['POST', '/contacts/upsert', 'Create or update a contact matched on email/phone', 'body', 'contacts'],
  ['PUT', '/contacts/{contactId}', 'Update a contact (must NOT include locationId)', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}', 'Delete a contact', 'none', 'contacts'],
  ['GET', '/contacts/search/duplicate', 'Find a duplicate by email or phone', 'q', 'contacts'],
  ['POST', '/contacts/{contactId}/tags', 'Add tags — body {tags:[…]}', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/tags', 'Remove tags — body {tags:[…]}', 'none', 'contacts'],
  ['GET', '/contacts/{contactId}/notes', 'List notes', 'none', 'contacts'],
  ['POST', '/contacts/{contactId}/notes', 'Add a note — body {body, userId?}', 'none', 'contacts'],
  ['GET', '/contacts/{contactId}/notes/{noteId}', 'Get a note', 'none', 'contacts'],
  ['PUT', '/contacts/{contactId}/notes/{noteId}', 'Update a note', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/notes/{noteId}', 'Delete a note', 'none', 'contacts'],
  ['GET', '/contacts/{contactId}/tasks', 'List tasks', 'none', 'contacts'],
  ['POST', '/contacts/{contactId}/tasks', 'Create a task — body {title, dueDate, completed, assignedTo}', 'none', 'contacts'],
  ['GET', '/contacts/{contactId}/tasks/{taskId}', 'Get a task', 'none', 'contacts'],
  ['PUT', '/contacts/{contactId}/tasks/{taskId}', 'Update a task', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/tasks/{taskId}', 'Delete a task', 'none', 'contacts'],
  ['PUT', '/contacts/{contactId}/tasks/{taskId}/completed', 'Complete/reopen a task — body {completed}', 'none', 'contacts'],
  ['GET', '/contacts/{contactId}/appointments', 'List a contact\'s appointments', 'none', 'contacts'],
  ['POST', '/contacts/{contactId}/workflow/{workflowId}', 'Enrol in a workflow (FIRES AUTOMATIONS)', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/workflow/{workflowId}', 'Remove from a workflow', 'none', 'contacts'],
  ['POST', '/contacts/{contactId}/campaigns/{campaignId}', 'Add to a campaign (SENDS MESSAGES)', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/campaigns/{campaignId}', 'Remove from a campaign', 'none', 'contacts'],
  ['DELETE', '/contacts/{contactId}/campaigns/removeAll', 'Remove from every campaign', 'none', 'contacts'],
  ['POST', '/contacts/bulk/business', 'Bulk-assign contacts to a business', 'body', 'contacts'],

  // --- conversations & messaging ---
  ['GET', '/conversations/search', 'Search conversations', 'q', 'conversations'],
  ['GET', '/conversations/{conversationId}', 'Get a conversation', 'none', 'conversations'],
  ['POST', '/conversations/', 'Create a conversation — body {locationId, contactId}', 'body', 'conversations'],
  ['PUT', '/conversations/{conversationId}', 'Update a conversation', 'none', 'conversations'],
  ['DELETE', '/conversations/{conversationId}', 'Delete a conversation', 'none', 'conversations'],
  ['GET', '/conversations/{conversationId}/messages', 'Message history', 'none', 'conversations'],
  ['GET', '/conversations/messages/{messageId}', 'Get one message', 'none', 'conversations'],
  ['POST', '/conversations/messages', 'SEND a message — body {type, contactId, message, subject?, html?}', 'none', 'conversations'],
  ['POST', '/conversations/messages/inbound', 'Record an inbound message (no send)', 'none', 'conversations'],
  ['PUT', '/conversations/messages/{messageId}/status', 'Update delivery status', 'none', 'conversations'],
  ['POST', '/conversations/messages/upload', 'Upload message attachments', 'none', 'conversations'],
  ['GET', '/conversations/providers/email/{messageId}', 'Email delivery detail', 'none', 'conversations'],

  // --- opportunities ---
  ['GET', '/opportunities/pipelines', 'Pipelines and their stage ids', 'q', 'opportunities'],
  ['GET', '/opportunities/search', 'Search opportunities (snake_case query params!)', 'q_snake', 'opportunities'],
  ['GET', '/opportunities/{id}', 'Get an opportunity', 'none', 'opportunities'],
  ['POST', '/opportunities/', 'Create an opportunity', 'body', 'opportunities'],
  ['PUT', '/opportunities/{id}', 'Update/move an opportunity (pipelineStageId moves stage)', 'none', 'opportunities'],
  ['DELETE', '/opportunities/{id}', 'Delete an opportunity', 'none', 'opportunities'],
  ['PUT', '/opportunities/{id}/status', 'Set status — body {status: open|won|lost|abandoned}', 'none', 'opportunities'],
  ['POST', '/opportunities/{id}/followers', 'Add followers', 'none', 'opportunities'],
  ['DELETE', '/opportunities/{id}/followers', 'Remove followers', 'none', 'opportunities'],

  // --- calendars ---
  ['GET', '/calendars/', 'List calendars', 'q', 'calendars'],
  ['GET', '/calendars/{calendarId}', 'Get a calendar', 'none', 'calendars'],
  ['POST', '/calendars/', 'Create a calendar', 'body', 'calendars'],
  ['PUT', '/calendars/{calendarId}', 'Update a calendar', 'none', 'calendars'],
  ['DELETE', '/calendars/{calendarId}', 'Delete a calendar', 'none', 'calendars'],
  ['GET', '/calendars/{calendarId}/free-slots', 'Bookable slots — startDate/endDate in epoch MILLISECONDS', 'none', 'calendars'],
  ['GET', '/calendars/events', 'Events in a window (startTime/endTime epoch ms)', 'q', 'calendars'],
  ['GET', '/calendars/events/appointments/{eventId}', 'Get an appointment', 'none', 'calendars'],
  ['POST', '/calendars/events/appointments', 'BOOK an appointment', 'body', 'calendars'],
  ['PUT', '/calendars/events/appointments/{eventId}', 'Reschedule/update an appointment', 'none', 'calendars'],
  ['DELETE', '/calendars/events/{eventId}', 'Cancel/delete an event', 'none', 'calendars'],
  ['POST', '/calendars/events/block-slots', 'Block time', 'body', 'calendars'],
  ['PUT', '/calendars/events/block-slots/{eventId}', 'Update a block', 'none', 'calendars'],
  ['GET', '/calendars/groups', 'List calendar groups', 'q', 'calendars'],
  ['POST', '/calendars/groups', 'Create a calendar group', 'body', 'calendars'],
  ['GET', '/calendars/{calendarId}/notifications', 'Calendar notification settings', 'none', 'calendars'],

  // --- forms & surveys ---
  ['GET', '/forms/', 'List forms', 'q', 'forms'],
  ['GET', '/forms/submissions', 'Form submissions (formId, page, limit, startAt, endAt)', 'q', 'forms'],
  ['POST', '/forms/upload-custom-files', 'Upload files for a form field', 'q', 'forms'],
  ['GET', '/surveys/', 'List surveys', 'q', 'surveys'],
  ['GET', '/surveys/submissions', 'Survey submissions (surveyId, page, limit)', 'q', 'surveys'],

  // --- location configuration ---
  ['GET', '/locations/{locationId}', 'Get the sub-account', 'path', 'locations'],
  ['PUT', '/locations/{locationId}', 'Update the sub-account', 'path', 'locations'],
  ['GET', '/locations/search', 'List sub-accounts', 'agency', 'locations'],
  ['POST', '/locations/', 'Create a sub-account', 'agency', 'locations'],
  ['GET', '/locations/{locationId}/customFields', 'List custom field definitions + ids', 'path', 'locations'],
  ['POST', '/locations/{locationId}/customFields', 'Create a custom field', 'path', 'locations'],
  ['GET', '/locations/{locationId}/customFields/{id}', 'Get a custom field', 'path', 'locations'],
  ['PUT', '/locations/{locationId}/customFields/{id}', 'Update a custom field', 'path', 'locations'],
  ['DELETE', '/locations/{locationId}/customFields/{id}', 'Delete a custom field', 'path', 'locations'],
  ['GET', '/locations/{locationId}/customValues', 'List custom values', 'path', 'locations'],
  ['POST', '/locations/{locationId}/customValues', 'Create a custom value', 'path', 'locations'],
  ['GET', '/locations/{locationId}/customValues/{id}', 'Get a custom value', 'path', 'locations'],
  ['PUT', '/locations/{locationId}/customValues/{id}', 'Update a custom value', 'path', 'locations'],
  ['DELETE', '/locations/{locationId}/customValues/{id}', 'Delete a custom value', 'path', 'locations'],
  ['GET', '/locations/{locationId}/tags', 'List tags', 'path', 'locations'],
  ['POST', '/locations/{locationId}/tags', 'Create a tag', 'path', 'locations'],
  ['GET', '/locations/{locationId}/tags/{tagId}', 'Get a tag', 'path', 'locations'],
  ['PUT', '/locations/{locationId}/tags/{tagId}', 'Update a tag', 'path', 'locations'],
  ['DELETE', '/locations/{locationId}/tags/{tagId}', 'Delete a tag', 'path', 'locations'],
  ['POST', '/locations/{locationId}/tasks/search', 'Search tasks across the sub-account', 'path', 'locations'],
  ['GET', '/locations/{locationId}/timezones', 'Available timezones', 'path', 'locations'],
  ['GET', '/locations/{locationId}/templates', 'SMS/email templates', 'path', 'locations'],

  // --- users ---
  ['GET', '/users/', 'List users in the sub-account', 'q', 'users'],
  ['GET', '/users/{userId}', 'Get a user', 'none', 'users'],
  ['POST', '/users/', 'Create a user', 'body', 'users'],
  ['PUT', '/users/{userId}', 'Update a user', 'none', 'users'],
  ['DELETE', '/users/{userId}', 'Delete a user', 'none', 'users'],
  ['GET', '/users/search', 'Search users (companyId, query)', 'agency', 'users'],

  // --- automation ---
  ['GET', '/workflows/', 'List workflows (read-only — the API cannot author workflows)', 'q', 'workflows'],
  ['GET', '/campaigns/', 'List campaigns', 'q', 'campaigns'],

  // --- commerce ---
  ['GET', '/products/', 'List products', 'q', 'products'],
  ['POST', '/products/', 'Create a product', 'body', 'products'],
  ['GET', '/products/{productId}', 'Get a product', 'q', 'products'],
  ['PUT', '/products/{productId}', 'Update a product', 'none', 'products'],
  ['DELETE', '/products/{productId}', 'Delete a product', 'none', 'products'],
  ['GET', '/products/{productId}/price', 'List prices for a product', 'q', 'products'],
  ['POST', '/products/{productId}/price', 'Create a price', 'body', 'products'],
  ['GET', '/products/{productId}/price/{priceId}', 'Get a price', 'q', 'products'],
  ['PUT', '/products/{productId}/price/{priceId}', 'Update a price', 'none', 'products'],
  ['DELETE', '/products/{productId}/price/{priceId}', 'Delete a price', 'none', 'products'],
  ['GET', '/invoices/', 'List invoices', 'alt', 'invoices'],
  ['POST', '/invoices/', 'Create an invoice', 'body', 'invoices'],
  ['GET', '/invoices/{invoiceId}', 'Get an invoice', 'alt', 'invoices'],
  ['PUT', '/invoices/{invoiceId}', 'Update an invoice', 'none', 'invoices'],
  ['DELETE', '/invoices/{invoiceId}', 'Delete an invoice', 'alt', 'invoices'],
  ['POST', '/invoices/{invoiceId}/send', 'SEND an invoice to the customer', 'body', 'invoices'],
  ['POST', '/invoices/{invoiceId}/void', 'Void an invoice', 'body', 'invoices'],
  ['POST', '/invoices/{invoiceId}/record-payment', 'Record a payment', 'body', 'invoices'],
  ['GET', '/invoices/template', 'List invoice templates', 'alt', 'invoices'],
  ['POST', '/invoices/template', 'Create an invoice template', 'body', 'invoices'],
  ['GET', '/invoices/schedule', 'List recurring invoice schedules', 'alt', 'invoices'],
  ['POST', '/invoices/schedule', 'Create a recurring invoice schedule', 'body', 'invoices'],
  ['GET', '/payments/orders', 'List orders', 'alt', 'payments'],
  ['GET', '/payments/orders/{orderId}', 'Get an order', 'alt', 'payments'],
  ['GET', '/payments/transactions', 'List transactions', 'alt', 'payments'],
  ['GET', '/payments/subscriptions', 'List subscriptions', 'alt', 'payments'],
  ['GET', '/payments/integrations/provider/whitelabel', 'White-label payment providers', 'alt', 'payments'],
  ['POST', '/payments/integrations/provider/whitelabel', 'Configure a white-label provider', 'body', 'payments'],
  ['GET', '/payments/custom-provider/provider', 'Get the custom payment provider', 'q', 'payments'],
  ['POST', '/payments/custom-provider/provider', 'Create a custom payment provider', 'q', 'payments'],

  // --- content & assets ---
  ['GET', '/funnels/funnel/list', 'List funnels', 'q', 'funnels'],
  ['GET', '/funnels/page', 'List funnel pages', 'q', 'funnels'],
  ['GET', '/links/', 'List trigger links', 'q', 'links'],
  ['POST', '/links/', 'Create a trigger link', 'body', 'links'],
  ['PUT', '/links/{linkId}', 'Update a trigger link', 'none', 'links'],
  ['DELETE', '/links/{linkId}', 'Delete a trigger link', 'none', 'links'],
  ['GET', '/businesses/', 'List businesses', 'q', 'businesses'],
  ['POST', '/businesses/', 'Create a business', 'body', 'businesses'],
  ['GET', '/businesses/{businessId}', 'Get a business', 'none', 'businesses'],
  ['PUT', '/businesses/{businessId}', 'Update a business', 'none', 'businesses'],
  ['DELETE', '/businesses/{businessId}', 'Delete a business', 'none', 'businesses'],
  ['GET', '/medias/files', 'List media files', 'alt', 'medias'],
  ['POST', '/medias/upload-file', 'Upload a media file (multipart — use the HighLevel UI or a direct upload)', 'alt', 'medias'],
  ['DELETE', '/medias/{fileId}', 'Delete a media file', 'alt', 'medias'],
  ['GET', '/emails/builder', 'List email templates', 'q', 'emails'],
  ['POST', '/emails/builder', 'Create an email template', 'body', 'emails'],
  ['DELETE', '/emails/builder/{locationId}/{templateId}', 'Delete an email template', 'path', 'emails'],
  ['GET', '/blogs/site/all', 'List blog sites', 'q', 'blogs'],
  ['GET', '/blogs/posts/all', 'List blog posts', 'q', 'blogs'],
  ['POST', '/blogs/posts', 'Create a blog post', 'body', 'blogs'],
  ['PUT', '/blogs/posts', 'Update a blog post', 'body', 'blogs'],
  ['GET', '/blogs/authors', 'List blog authors', 'q', 'blogs'],
  ['GET', '/blogs/categories', 'List blog categories', 'q', 'blogs'],
  ['POST', '/social-media-posting/{locationId}/posts/list', 'List social planner posts', 'path', 'social'],
  ['POST', '/social-media-posting/{locationId}/posts', 'Create a social post (PUBLISHES)', 'path', 'social'],
  ['PUT', '/social-media-posting/{locationId}/posts/{postId}', 'Update a social post', 'path', 'social'],
  ['DELETE', '/social-media-posting/{locationId}/posts/{postId}', 'Delete a social post', 'path', 'social'],
  ['GET', '/social-media-posting/{locationId}/accounts', 'List connected social accounts', 'path', 'social'],
  ['GET', '/custom-menus/', 'List custom menu links', 'q', 'custom-menus'],
  ['GET', '/courses/', 'Courses / memberships', 'q', 'courses'],
  ['GET', '/objects/', 'Custom objects', 'q', 'objects'],
  ['GET', '/associations/', 'Record associations', 'q', 'associations'],

  // --- agency / SaaS (mostly unavailable to a sub-account credential) ---
  ['GET', '/snapshots/', 'List snapshots', 'agency', 'snapshots'],
  ['POST', '/snapshots/snapshot-share/link', 'Create a snapshot share link', 'agency', 'snapshots'],
  ['GET', '/saas-api/', 'SaaS mode subscription management', 'agency', 'saas'],
  ['GET', '/oauth/installedLocations', 'Sub-accounts an OAuth app is installed on', 'agency', 'oauth'],
  ['POST', '/oauth/locationToken', 'Mint a sub-account token from an agency token', 'agency', 'oauth'],
].map(([method, path, summary, loc, domain]) => ({ method, path, summary, loc, domain }));

const LOC_EXPLANATION = {
  q: 'Sub-account id goes in the query string as ?locationId=… (added for you unless you pass one).',
  q_snake: 'This endpoint uses snake_case query params: ?location_id=… (added for you).',
  alt: 'This endpoint wants ?altId=<locationId>&altType=location (added for you).',
  path: 'The sub-account id is a path segment — use {locationId} in the path and it is substituted for you.',
  body: 'The sub-account id belongs in the request body as locationId (added for you if the body omits it).',
  none: 'No sub-account id needed — the record id identifies it.',
  agency: 'Needs an AGENCY-level credential. A sub-account Private Integration Token returns 401/403 here; that is expected, not a bug.',
};

function search(query, { domain, method, limit = 25 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = OPERATIONS
    .filter((op) => (!domain || op.domain === domain.toLowerCase()))
    .filter((op) => (!method || op.method === String(method).toUpperCase()))
    .map((op) => {
      const haystack = `${op.method} ${op.path} ${op.summary} ${op.domain}`.toLowerCase();
      const score = terms.length
        ? terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0)
        : 1;
      return { op, score };
    })
    .filter((x) => x.score > 0 || !terms.length)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.op);
}

function describe(method, path) {
  const wanted = String(path || '').trim();
  const m = String(method || '').toUpperCase();
  const exact = OPERATIONS.find((op) => op.method === m && op.path === wanted);
  if (exact) return exact;
  // Tolerate a concrete path with real ids in it, e.g. /contacts/abc123.
  return OPERATIONS.find((op) => {
    if (op.method !== m) return false;
    const pattern = new RegExp(`^${op.path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/')}$`);
    return pattern.test(wanted);
  }) || null;
}

function domains() {
  return [...new Set(OPERATIONS.map((op) => op.domain))].sort();
}

module.exports = { OPERATIONS, LOC_EXPLANATION, search, describe, domains };
