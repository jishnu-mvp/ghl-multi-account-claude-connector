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
// Contacts, tags, notes and tasks.

const { tool, get, send, render, readAndBackup, asObject, asTags } = require('./kit');
const safety = require('../safety');

const tools = [
  tool({
    name: 'ghl_list_contacts',
    title: 'List contacts',
    description: 'List or keyword-search contacts in a sub-account. For filtering by tag, custom field or date, use ghl_search_contacts instead.',
    props: {
      query: { type: 'string', description: 'Free-text search (name, email, phone).' },
      limit: { type: 'number', description: 'Page size, max 100. Default 100.' },
      start_after_id: { type: 'string', description: 'Contact id to page after (from the previous page).' },
      start_after: { type: 'number', description: 'Epoch ms cursor to page after, used together with start_after_id.' },
    },
    handler: (args, ctx) => get(ctx, '/contacts/', {
      locationId: ctx.location(),
      limit: Math.min(args.limit || 100, 100),
      query: args.query,
      startAfterId: args.start_after_id,
      startAfter: args.start_after,
    }),
  }),

  tool({
    name: 'ghl_search_contacts',
    title: 'Search contacts',
    description: 'The real contact search surface: POST /contacts/search with filters and sorting (by tag, custom field, date added, DND, …). Pass the body HighLevel documents; locationId is filled in for you.',
    props: {
      filters: { type: 'array', description: 'HighLevel filter objects, e.g. [{"field":"tags","operator":"contains","value":"vip"}].', items: { type: 'object' } },
      sort: { type: 'array', description: 'Sort objects, e.g. [{"field":"dateAdded","direction":"desc"}].', items: { type: 'object' } },
      page: { type: 'number', description: 'Page number, 1-based.' },
      page_limit: { type: 'number', description: 'Results per page (default 20).' },
      body: { type: 'object', description: 'Full request body, if you would rather build it yourself. Merged over the other arguments.' },
    },
    handler: (args, ctx) => send(ctx, 'POST', '/contacts/search', {
      body: {
        locationId: ctx.location(),
        page: args.page || 1,
        pageLimit: args.page_limit || 20,
        ...(args.filters ? { filters: args.filters } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(asObject(args.body, 'body') || {}),
      },
    }),
  }),

  tool({
    name: 'ghl_get_contact',
    title: 'Get a contact',
    description: 'Fetch one contact in full, including custom fields and tags. Always do this before updating a contact.',
    props: { contact_id: { type: 'string', description: 'Contact id.' } },
    required: ['contact_id'],
    handler: (args, ctx) => get(ctx, `/contacts/${encodeURIComponent(args.contact_id)}`),
  }),

  tool({
    name: 'ghl_export_contact',
    title: 'Back up a contact',
    description: 'Fetch a contact and save it to a local backup file outside the repository. Use before any risky edit; the file path is returned.',
    props: { contact_id: { type: 'string', description: 'Contact id.' } },
    required: ['contact_id'],
    handler: async (args, ctx) => {
      const { current, backupFile } = await readAndBackup(ctx, {
        kind: 'contact',
        id: args.contact_id,
        path: `/contacts/${encodeURIComponent(args.contact_id)}`,
      });
      return render({
        ctx,
        request: { method: 'GET', path: `/contacts/${args.contact_id}` },
        data: current,
        notes: [`Backed up to ${backupFile}`],
      });
    },
  }),

  tool({
    name: 'ghl_duplicate_check',
    title: 'Check for a duplicate contact',
    description: 'Look for an existing contact by email or phone before creating one.',
    props: {
      email: { type: 'string', description: 'Email to look for.' },
      phone: { type: 'string', description: 'Phone to look for (E.164, e.g. +61400000000).' },
    },
    handler: (args, ctx) => {
      if (!args.email && !args.phone) throw new Error('Give an email or a phone number to check.');
      return get(ctx, '/contacts/search/duplicate', { locationId: ctx.location(), email: args.email, phone: args.phone });
    },
  }),

  tool({
    name: 'ghl_create_contact',
    title: 'Create a contact',
    kind: 'write',
    description: 'Create a contact. locationId is added automatically. Check ghl_duplicate_check first, and use existing tags from ghl_list_tags rather than inventing new ones (HighLevel creates tags implicitly, so a typo becomes permanent clutter).',
    props: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string', description: 'E.164 format, e.g. +61400000000.' },
      tags: { type: ['array', 'string'], items: { type: 'string' }, description: 'Existing tags only, kebab-case. Array, or a comma-separated string.' },
      source: { type: 'string', description: 'Where the contact came from.' },
      custom_fields: { type: 'array', items: { type: 'object' }, description: 'Custom fields as [{"id":"<fieldId>","value":"…"}] — resolve ids with ghl_custom_fields, never hardcode them.' },
      body: { type: 'object', description: 'Extra body fields, merged last (address, companyName, dnd, …).' },
    },
    handler: (args, ctx) => send(ctx, 'POST', '/contacts/', {
      body: {
        locationId: ctx.location(),
        ...(args.first_name ? { firstName: args.first_name } : {}),
        ...(args.last_name ? { lastName: args.last_name } : {}),
        ...(args.email ? { email: args.email } : {}),
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.tags ? { tags: asTags(args.tags) } : {}),
        ...(args.source ? { source: args.source } : {}),
        ...(args.custom_fields ? { customFields: args.custom_fields } : {}),
        ...(asObject(args.body, 'body') || {}),
      },
      notes: ['Re-read the contact with ghl_get_contact to verify — a 200 is not proof.'],
    }),
  }),

  tool({
    name: 'ghl_upsert_contact',
    title: 'Create or update a contact',
    kind: 'write',
    description: 'Create-or-update a contact matched on email or phone. Safer than create when the contact may already exist.',
    props: {
      email: { type: 'string' },
      phone: { type: 'string' },
      body: { type: 'object', description: 'The rest of the contact body (firstName, lastName, tags, customFields, …).' },
    },
    handler: (args, ctx) => send(ctx, 'POST', '/contacts/upsert', {
      body: {
        locationId: ctx.location(),
        ...(args.email ? { email: args.email } : {}),
        ...(args.phone ? { phone: args.phone } : {}),
        ...(asObject(args.body, 'body') || {}),
      },
    }),
  }),

  tool({
    name: 'ghl_update_contact',
    title: 'Update a contact',
    kind: 'write',
    description: 'Update a contact. Reads the current record and saves a backup first, so nothing is overwritten blind. Do not pass locationId — HighLevel rejects it on update.',
    props: {
      contact_id: { type: 'string', description: 'Contact id.' },
      updates: { type: 'object', description: 'Only the fields to change, e.g. {"firstName":"Jane","tags":["vip"]}. Must not contain locationId.' },
    },
    required: ['contact_id', 'updates'],
    handler: async (args, ctx) => {
      const updates = asObject(args.updates, 'updates');
      if (updates.locationId) throw new Error('Remove locationId from `updates` — HighLevel returns 400 if a contact update includes it.');
      const { current, backupFile } = await readAndBackup(ctx, {
        kind: 'contact', id: args.contact_id, path: `/contacts/${encodeURIComponent(args.contact_id)}`,
      });
      const before = (current && (current.contact || current)) || {};
      const res = await ctx.call({ method: 'PUT', path: `/contacts/${encodeURIComponent(args.contact_id)}`, body: updates });
      return render({
        ctx,
        request: { method: 'PUT', path: `/contacts/${args.contact_id}` },
        data: res.data,
        notes: [
          `Backed up to ${backupFile}`,
          `Was: ${JSON.stringify({ firstName: before.firstName, lastName: before.lastName, email: before.email, phone: before.phone, tags: before.tags })}`,
          'Verify with ghl_get_contact.',
        ],
      });
    },
  }),

  tool({
    name: 'ghl_delete_contact',
    title: 'Delete a contact',
    kind: 'destructive',
    description: 'Delete a contact. Requires explicit confirmation and exports the record first. There is no undo in HighLevel.',
    props: {
      contact_id: { type: 'string', description: 'Contact id.' },
      confirm: { type: 'boolean', description: 'Must be true. Show the dry run to the user and get a clear go-ahead first.' },
    },
    required: ['contact_id'],
    handler: async (args, ctx) => {
      const { current, backupFile } = await readAndBackup(ctx, {
        kind: 'contact', id: args.contact_id, path: `/contacts/${encodeURIComponent(args.contact_id)}`,
      });
      const c = (current && (current.contact || current)) || {};
      safety.gate({
        confirm: args.confirm,
        action: `delete contact ${args.contact_id} — ${c.firstName || ''} ${c.lastName || ''} <${c.email || 'no email'}> ${c.phone || ''}`.trim(),
        consequence: 'The contact and its history are removed from the CRM. HighLevel has no undo.',
        request: { method: 'DELETE', path: `/contacts/${args.contact_id}` },
        accountLabel: ctx.label,
      });
      const res = await ctx.call({ method: 'DELETE', path: `/contacts/${encodeURIComponent(args.contact_id)}` });
      return render({ ctx, request: { method: 'DELETE', path: `/contacts/${args.contact_id}` }, data: res.data, notes: [`Exported to ${backupFile} before deletion`] });
    },
  }),

  tool({
    name: 'ghl_add_tags',
    title: 'Add tags to a contact',
    kind: 'write',
    description: 'Add tags to a contact. Check ghl_list_tags first — HighLevel creates a tag on write, so a typo becomes a permanent new tag.',
    props: {
      contact_id: { type: 'string' },
      tags: { type: ['array', 'string'], items: { type: 'string' }, description: 'Tags to add (kebab-case). Array, or a comma-separated string.' },
    },
    required: ['contact_id', 'tags'],
    handler: (args, ctx) => send(ctx, 'POST', `/contacts/${encodeURIComponent(args.contact_id)}/tags`, {
      body: { tags: asTags(args.tags) },
    }),
  }),

  tool({
    name: 'ghl_remove_tags',
    title: 'Remove tags from a contact',
    kind: 'write',
    description: 'Remove tags from a contact. The tags stay in the sub-account vocabulary.',
    props: {
      contact_id: { type: 'string' },
      tags: { type: ['array', 'string'], items: { type: 'string' }, description: 'Tags to remove. Array, or a comma-separated string.' },
    },
    required: ['contact_id', 'tags'],
    handler: (args, ctx) => send(ctx, 'DELETE', `/contacts/${encodeURIComponent(args.contact_id)}/tags`, {
      body: { tags: asTags(args.tags) },
    }),
  }),

  tool({
    name: 'ghl_contact_notes',
    title: 'Contact notes',
    description: 'List the notes on a contact — the internal history the team has written about them.',
    props: { contact_id: { type: 'string' } },
    required: ['contact_id'],
    handler: (args, ctx) => get(ctx, `/contacts/${encodeURIComponent(args.contact_id)}/notes`),
  }),

  tool({
    name: 'ghl_add_note',
    title: 'Add a note',
    kind: 'write',
    description: 'Add a note to a contact. Internal only — the contact is not notified.',
    props: {
      contact_id: { type: 'string' },
      body: { type: 'string', description: 'Note text.' },
      user_id: { type: 'string', description: 'Attribute the note to this user id (optional).' },
    },
    required: ['contact_id', 'body'],
    handler: (args, ctx) => send(ctx, 'POST', `/contacts/${encodeURIComponent(args.contact_id)}/notes`, {
      body: { body: args.body, ...(args.user_id ? { userId: args.user_id } : {}) },
    }),
  }),

  tool({
    name: 'ghl_update_note',
    title: 'Update a note',
    kind: 'write',
    description: 'Edit an existing note on a contact, replacing its text.',
    props: {
      contact_id: { type: 'string' },
      note_id: { type: 'string' },
      body: { type: 'string', description: 'Replacement note text.' },
    },
    required: ['contact_id', 'note_id', 'body'],
    handler: (args, ctx) => send(ctx, 'PUT', `/contacts/${encodeURIComponent(args.contact_id)}/notes/${encodeURIComponent(args.note_id)}`, {
      body: { body: args.body },
    }),
  }),

  tool({
    name: 'ghl_delete_note',
    title: 'Delete a note',
    kind: 'destructive',
    description: 'Delete a note from a contact. Needs confirmation.',
    props: {
      contact_id: { type: 'string' },
      note_id: { type: 'string' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['contact_id', 'note_id'],
    handler: async (args, ctx) => {
      const path = `/contacts/${encodeURIComponent(args.contact_id)}/notes/${encodeURIComponent(args.note_id)}`;
      safety.gate({
        confirm: args.confirm,
        action: `delete note ${args.note_id} from contact ${args.contact_id}`,
        consequence: 'The note text is gone for good.',
        request: { method: 'DELETE', path },
        accountLabel: ctx.label,
      });
      return send(ctx, 'DELETE', path);
    },
  }),

  tool({
    name: 'ghl_contact_tasks',
    title: 'Contact tasks',
    description: 'List the tasks attached to a contact, with their due dates and completion state.',
    props: { contact_id: { type: 'string' } },
    required: ['contact_id'],
    handler: (args, ctx) => get(ctx, `/contacts/${encodeURIComponent(args.contact_id)}/tasks`),
  }),

  tool({
    name: 'ghl_add_task',
    title: 'Add a task',
    kind: 'write',
    description: 'Create a task against a contact. Internal to the team; the contact is not notified.',
    props: {
      contact_id: { type: 'string' },
      title: { type: 'string', description: 'Task title.' },
      due_date: { type: 'string', description: 'Due date, ISO 8601 (e.g. 2026-09-15T09:00:00+10:00).' },
      body: { type: 'string', description: 'Task description.' },
      assigned_to: { type: 'string', description: 'User id to assign to (see ghl_list_users).' },
      completed: { type: 'boolean', description: 'Create it already complete. Default false.' },
    },
    required: ['contact_id', 'title'],
    handler: (args, ctx) => send(ctx, 'POST', `/contacts/${encodeURIComponent(args.contact_id)}/tasks`, {
      body: {
        title: args.title,
        completed: args.completed === true,
        ...(args.due_date ? { dueDate: args.due_date } : {}),
        ...(args.body ? { body: args.body } : {}),
        ...(args.assigned_to ? { assignedTo: args.assigned_to } : {}),
      },
    }),
  }),

  tool({
    name: 'ghl_complete_task',
    title: 'Complete a task',
    kind: 'write',
    description: 'Mark a contact task complete (or reopen it).',
    props: {
      contact_id: { type: 'string' },
      task_id: { type: 'string' },
      completed: { type: 'boolean', description: 'true to complete, false to reopen. Default true.' },
    },
    required: ['contact_id', 'task_id'],
    handler: (args, ctx) => send(ctx, 'PUT', `/contacts/${encodeURIComponent(args.contact_id)}/tasks/${encodeURIComponent(args.task_id)}/completed`, {
      body: { completed: args.completed !== false },
    }),
  }),

  tool({
    name: 'ghl_contact_appointments',
    title: 'Contact appointments',
    description: 'List a contact\'s appointments, past and upcoming, across every calendar.',
    props: { contact_id: { type: 'string' } },
    required: ['contact_id'],
    handler: (args, ctx) => get(ctx, `/contacts/${encodeURIComponent(args.contact_id)}/appointments`),
  }),
];

module.exports = tools;
