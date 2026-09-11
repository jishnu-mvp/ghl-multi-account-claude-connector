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
// Sub-account configuration: custom fields, custom values, tags, users, forms, surveys.
// Ids in here are opaque — resolve them at runtime, never hardcode them.

const { tool, get, send, asObject } = require('./kit');
const safety = require('../safety');

const tools = [
  tool({
    name: 'ghl_get_location',
    title: 'Get the sub-account',
    description: 'The sub-account (location) record: business details, timezone, settings.',
    props: {},
    handler: (args, ctx) => get(ctx, `/locations/${encodeURIComponent(ctx.location())}`),
  }),

  tool({
    name: 'ghl_list_locations',
    title: 'List sub-accounts (agency token)',
    description: 'List sub-accounts under an agency. Needs an AGENCY-level credential — a sub-account token gets 401/403 here, which is expected, not a bug.',
    props: {
      company_id: { type: 'string', description: 'Agency/company id. Defaults to the one captured at login.' },
      limit: { type: 'number' },
      skip: { type: 'number' },
    },
    handler: (args, ctx) => get(ctx, '/locations/search', {
      companyId: args.company_id || ctx.account.companyId || require('../accounts').envVar('GHL_COMPANY_ID'),
      limit: args.limit,
      skip: args.skip,
    }),
  }),

  tool({
    name: 'ghl_custom_fields',
    title: 'List custom fields',
    description: 'Custom field definitions with their ids. Always resolve field ids here before reading or writing custom field values — never assume a key.',
    props: {
      model: { type: 'string', description: 'Filter by model, e.g. contact or opportunity.' },
    },
    handler: (args, ctx) => get(ctx, `/locations/${encodeURIComponent(ctx.location())}/customFields`, { model: args.model }),
  }),

  tool({
    name: 'ghl_create_custom_field',
    title: 'Create a custom field',
    kind: 'write',
    description: 'Create a custom field definition. Requires confirmation — a stray field is permanent clutter across the whole sub-account, and this must never happen as a side effect of another task.',
    props: {
      name: { type: 'string', description: 'Field name.' },
      data_type: { type: 'string', description: 'HighLevel data type, e.g. TEXT, LARGE_TEXT, NUMERICAL, PHONE, MONETORY, CHECKBOX, SINGLE_OPTIONS, MULTIPLE_OPTIONS, DATE, TEXTBOX_LIST, FILE_UPLOAD.' },
      model: { type: 'string', description: 'contact or opportunity. Default contact.' },
      body: { type: 'object', description: 'Extra body fields (placeholder, options, position, …), merged last.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['name', 'data_type'],
    handler: async (args, ctx) => {
      const path = `/locations/${encodeURIComponent(ctx.location())}/customFields`;
      const body = {
        name: args.name,
        dataType: args.data_type,
        model: args.model || 'contact',
        ...(asObject(args.body, 'body') || {}),
      };
      safety.gate({
        confirm: args.confirm,
        action: `create custom field "${args.name}" (${args.data_type}) on ${args.model || 'contact'}`,
        consequence: 'The field appears for every record of that type in this sub-account and cannot be cleanly undone.',
        request: { method: 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_custom_values',
    title: 'List custom values',
    description: 'Sub-account custom values (the merge fields used in templates) with their ids.',
    props: {},
    handler: (args, ctx) => get(ctx, `/locations/${encodeURIComponent(ctx.location())}/customValues`),
  }),

  tool({
    name: 'ghl_set_custom_value',
    title: 'Create or update a custom value',
    kind: 'write',
    description: 'Create a custom value, or update one by id. Custom values feed live templates and automations, so this is confirmation-gated.',
    props: {
      name: { type: 'string', description: 'Custom value name (required when creating).' },
      value: { type: 'string', description: 'The value to store.' },
      custom_value_id: { type: 'string', description: 'Update this existing custom value instead of creating one.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['value'],
    handler: async (args, ctx) => {
      const base = `/locations/${encodeURIComponent(ctx.location())}/customValues`;
      const isUpdate = Boolean(args.custom_value_id);
      const path = isUpdate ? `${base}/${encodeURIComponent(args.custom_value_id)}` : base;
      if (!isUpdate && !args.name) throw new Error('Creating a custom value needs a `name`.');
      const body = { ...(args.name ? { name: args.name } : {}), value: args.value };
      safety.gate({
        confirm: args.confirm,
        action: isUpdate ? `update custom value ${args.custom_value_id}` : `create custom value "${args.name}"`,
        consequence: 'Templates, emails and automations that reference this value change immediately.',
        request: { method: isUpdate ? 'PUT' : 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, isUpdate ? 'PUT' : 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_list_tags',
    title: 'List tags',
    description: 'The sub-account\'s tag vocabulary. Check this before tagging anything — HighLevel creates tags implicitly on write, so a typo becomes permanent clutter.',
    props: {},
    handler: (args, ctx) => get(ctx, `/locations/${encodeURIComponent(ctx.location())}/tags`),
  }),

  tool({
    name: 'ghl_create_tag',
    title: 'Create a tag',
    kind: 'write',
    description: 'Add a tag to the sub-account vocabulary. Confirmation-gated: tags must be a deliberate decision, never a side effect. Use kebab-case.',
    props: {
      name: { type: 'string', description: 'Tag name, kebab-case.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['name'],
    handler: async (args, ctx) => {
      const path = `/locations/${encodeURIComponent(ctx.location())}/tags`;
      safety.gate({
        confirm: args.confirm,
        action: `create the tag "${args.name}"`,
        consequence: 'It joins this sub-account\'s permanent tag vocabulary. Check ghl_list_tags for an existing tag that already means this.',
        request: { method: 'POST', path, body: { name: args.name } },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body: { name: args.name } });
    },
  }),

  tool({
    name: 'ghl_search_tasks',
    title: 'Search tasks across the sub-account',
    description: 'Search tasks across the whole sub-account (not just one contact).',
    props: {
      body: { type: 'object', description: 'Search body: {completed, assignedTo, contactId, dueDate, limit, skip, …}.' },
    },
    handler: (args, ctx) => send(ctx, 'POST', `/locations/${encodeURIComponent(ctx.location())}/tasks/search`, {
      body: asObject(args.body, 'body') || {},
    }),
  }),

  tool({
    name: 'ghl_list_users',
    title: 'List users',
    description: 'Users/staff in the sub-account with their ids — needed to assign tasks, opportunities and appointments.',
    props: {},
    handler: (args, ctx) => get(ctx, '/users/', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_get_user',
    title: 'Get a user',
    description: 'Fetch one user by id: name, email, role and permissions in this sub-account.',
    props: { user_id: { type: 'string' } },
    required: ['user_id'],
    handler: (args, ctx) => get(ctx, `/users/${encodeURIComponent(args.user_id)}`),
  }),

  tool({
    name: 'ghl_list_custom_menus',
    title: 'List custom menu links',
    description: 'List the custom menu links configured in a sub-account\'s sidebar.',
    props: {},
    handler: (args, ctx) => get(ctx, '/custom-menus/', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_location_timezones',
    title: 'List timezones',
    description: 'List the timezone identifiers HighLevel accepts for this sub-account.',
    props: {},
    handler: (args, ctx) => get(ctx, `/locations/${encodeURIComponent(ctx.location())}/timezones`),
  }),

  tool({
    name: 'ghl_list_forms',
    title: 'List forms',
    description: 'List the forms in a sub-account with their ids, for reading submissions.',
    props: { limit: { type: 'number' }, skip: { type: 'number' } },
    handler: (args, ctx) => get(ctx, '/forms/', { locationId: ctx.location(), limit: args.limit, skip: args.skip }),
  }),

  tool({
    name: 'ghl_form_submissions',
    title: 'Form submissions',
    description: 'Form submissions, optionally for one form or date range. Contains whatever the person typed, so treat it as personal data.',
    props: {
      form_id: { type: 'string' },
      page: { type: 'number' },
      limit: { type: 'number' },
      start_at: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
      end_at: { type: 'string', description: 'End date, YYYY-MM-DD.' },
    },
    handler: (args, ctx) => get(ctx, '/forms/submissions', {
      locationId: ctx.location(),
      formId: args.form_id,
      page: args.page,
      limit: args.limit,
      startAt: args.start_at,
      endAt: args.end_at,
    }),
  }),

  tool({
    name: 'ghl_list_surveys',
    title: 'List surveys',
    description: 'List the surveys in a sub-account with their ids, for reading submissions.',
    props: { limit: { type: 'number' }, skip: { type: 'number' } },
    handler: (args, ctx) => get(ctx, '/surveys/', { locationId: ctx.location(), limit: args.limit, skip: args.skip }),
  }),

  tool({
    name: 'ghl_survey_submissions',
    title: 'Survey submissions',
    description: 'Read survey submissions, optionally for one survey or date range. Personal data — summarise it.',
    props: {
      survey_id: { type: 'string' },
      page: { type: 'number' },
      limit: { type: 'number' },
      start_at: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
      end_at: { type: 'string', description: 'End date, YYYY-MM-DD.' },
    },
    handler: (args, ctx) => get(ctx, '/surveys/submissions', {
      locationId: ctx.location(),
      surveyId: args.survey_id,
      page: args.page,
      limit: args.limit,
      startAt: args.start_at,
      endAt: args.end_at,
    }),
  }),
];

module.exports = tools;
