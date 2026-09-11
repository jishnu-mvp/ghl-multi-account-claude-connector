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
// Calendars, free slots and appointments. Booking, moving or cancelling an appointment
// changes a real person's diary, so those are gated.

const { tool, get, send, render, readAndBackup, asObject } = require('./kit');
const safety = require('../safety');

// The API takes epoch milliseconds here, not ISO strings — accept either and convert.
function toEpochMs(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Math.round(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`"${name}" must be epoch milliseconds or an ISO 8601 date-time; got "${value}".`);
  return parsed;
}

const tools = [
  tool({
    name: 'ghl_list_calendars',
    title: 'List calendars',
    description: 'List calendars in a sub-account with their ids.',
    props: {
      group_id: { type: 'string', description: 'Only calendars in this group.' },
      show_drafted: { type: 'boolean', description: 'Include drafted calendars.' },
    },
    handler: (args, ctx) => get(ctx, '/calendars/', {
      locationId: ctx.location(),
      groupId: args.group_id,
      showDrafted: args.show_drafted,
    }),
  }),

  tool({
    name: 'ghl_get_calendar',
    title: 'Get a calendar',
    description: 'Fetch one calendar\'s configuration (availability, duration, team members).',
    props: { calendar_id: { type: 'string' } },
    required: ['calendar_id'],
    handler: (args, ctx) => get(ctx, `/calendars/${encodeURIComponent(args.calendar_id)}`),
  }),

  tool({
    name: 'ghl_free_slots',
    title: 'Find bookable slots',
    description: 'List bookable slots on a calendar in a date range. Accepts ISO date-times or epoch milliseconds.',
    props: {
      calendar_id: { type: 'string' },
      start: { type: ['string', 'number'], description: 'Range start — ISO 8601 or epoch ms.' },
      end: { type: ['string', 'number'], description: 'Range end — ISO 8601 or epoch ms.' },
      timezone: { type: 'string', description: 'IANA timezone for the returned slots, e.g. Australia/Sydney.' },
      user_id: { type: 'string', description: 'Only this user\'s availability.' },
    },
    required: ['calendar_id', 'start', 'end'],
    handler: (args, ctx) => get(ctx, `/calendars/${encodeURIComponent(args.calendar_id)}/free-slots`, {
      startDate: toEpochMs(args.start, 'start'),
      endDate: toEpochMs(args.end, 'end'),
      timezone: args.timezone,
      userId: args.user_id,
    }),
  }),

  tool({
    name: 'ghl_list_events',
    title: 'List calendar events',
    description: 'List calendar events (appointments and blocks) in a time window.',
    props: {
      start: { type: ['string', 'number'], description: 'Window start — ISO 8601 or epoch ms.' },
      end: { type: ['string', 'number'], description: 'Window end — ISO 8601 or epoch ms.' },
      calendar_id: { type: 'string' },
      group_id: { type: 'string' },
      user_id: { type: 'string' },
    },
    required: ['start', 'end'],
    handler: (args, ctx) => get(ctx, '/calendars/events', {
      locationId: ctx.location(),
      startTime: toEpochMs(args.start, 'start'),
      endTime: toEpochMs(args.end, 'end'),
      calendarId: args.calendar_id,
      groupId: args.group_id,
      userId: args.user_id,
    }),
  }),

  tool({
    name: 'ghl_get_appointment',
    title: 'Get an appointment',
    description: 'Fetch one appointment by event id: time, status, contact and assigned user.',
    props: { event_id: { type: 'string' } },
    required: ['event_id'],
    handler: (args, ctx) => get(ctx, `/calendars/events/appointments/${encodeURIComponent(args.event_id)}`),
  }),

  tool({
    name: 'ghl_create_appointment',
    title: 'Book an appointment',
    kind: 'outbound',
    description:
      'BOOKS A REAL APPOINTMENT — it appears in the team\'s calendar and usually triggers a ' +
      'confirmation to the contact. Requires explicit user confirmation. Check ghl_free_slots first.',
    props: {
      calendar_id: { type: 'string' },
      contact_id: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-09-15T10:00:00+10:00.' },
      end_time: { type: 'string', description: 'ISO 8601. Optional — the calendar\'s duration is used if omitted.' },
      title: { type: 'string' },
      appointment_status: { type: 'string', description: 'e.g. confirmed, new, showed, noshow, cancelled.' },
      assigned_user_id: { type: 'string' },
      address: { type: 'string', description: 'Location or meeting link.' },
      ignore_free_slot_validation: { type: 'boolean', description: 'Book outside available slots. Use sparingly.' },
      body: { type: 'object', description: 'Extra body fields, merged last.' },
      confirm: { type: 'boolean', description: 'Must be true to book.' },
    },
    required: ['calendar_id', 'contact_id', 'start_time'],
    handler: async (args, ctx) => {
      const payload = {
        calendarId: args.calendar_id,
        locationId: ctx.location(),
        contactId: args.contact_id,
        startTime: args.start_time,
        ...(args.end_time ? { endTime: args.end_time } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.appointment_status ? { appointmentStatus: args.appointment_status } : {}),
        ...(args.assigned_user_id ? { assignedUserId: args.assigned_user_id } : {}),
        ...(args.address ? { address: args.address } : {}),
        ...(args.ignore_free_slot_validation !== undefined ? { ignoreFreeSlotValidation: args.ignore_free_slot_validation } : {}),
        ...(asObject(args.body, 'body') || {}),
      };
      safety.gate({
        confirm: args.confirm,
        action: `book ${args.start_time} on calendar ${args.calendar_id} for contact ${args.contact_id}`,
        consequence: 'A real appointment is created; HighLevel normally emails/SMSes the contact a confirmation.',
        request: { method: 'POST', path: '/calendars/events/appointments', body: payload },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', '/calendars/events/appointments', {
        body: payload,
        notes: ['Verify with ghl_get_appointment on the returned event id.'],
      });
    },
  }),

  tool({
    name: 'ghl_update_appointment',
    title: 'Reschedule or update an appointment',
    kind: 'outbound',
    description: 'Reschedule or change an appointment. The contact is normally notified. Reads and backs up the current appointment first, and requires confirmation.',
    props: {
      event_id: { type: 'string' },
      start_time: { type: 'string', description: 'New ISO 8601 start time.' },
      end_time: { type: 'string', description: 'New ISO 8601 end time.' },
      appointment_status: { type: 'string', description: 'e.g. confirmed, showed, noshow, cancelled.' },
      title: { type: 'string' },
      assigned_user_id: { type: 'string' },
      updates: { type: 'object', description: 'Any other fields, merged last.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['event_id'],
    handler: async (args, ctx) => {
      const updates = {
        ...(args.start_time ? { startTime: args.start_time } : {}),
        ...(args.end_time ? { endTime: args.end_time } : {}),
        ...(args.appointment_status ? { appointmentStatus: args.appointment_status } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.assigned_user_id ? { assignedUserId: args.assigned_user_id } : {}),
        ...(asObject(args.updates, 'updates') || {}),
      };
      if (!Object.keys(updates).length) throw new Error('Nothing to change — pass start_time, end_time, appointment_status, title, assigned_user_id or updates.');

      const readPath = `/calendars/events/appointments/${encodeURIComponent(args.event_id)}`;
      const { current, backupFile } = await readAndBackup(ctx, { kind: 'appointment', id: args.event_id, path: readPath });
      const before = (current && (current.appointment || current.event || current)) || {};
      safety.gate({
        confirm: args.confirm,
        action: `change appointment ${args.event_id} (currently ${before.startTime || 'unknown time'}, status ${before.appointmentStatus || 'unknown'})`,
        consequence: 'The booking changes and HighLevel normally notifies the contact and the assigned user.',
        request: { method: 'PUT', path: readPath, body: updates },
        accountLabel: ctx.label,
      });
      const res = await ctx.call({ method: 'PUT', path: readPath, body: updates });
      return render({ ctx, request: { method: 'PUT', path: readPath }, data: res.data, notes: [`Backed up to ${backupFile}`, 'Verify with ghl_get_appointment.'] });
    },
  }),

  tool({
    name: 'ghl_delete_event',
    title: 'Cancel or delete a calendar event',
    kind: 'destructive',
    description: 'Delete a calendar event (appointment or block). The contact is normally notified of the cancellation. Backs the event up first and requires confirmation.',
    props: {
      event_id: { type: 'string' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['event_id'],
    handler: async (args, ctx) => {
      let backupFile = null;
      let before = {};
      try {
        const backedUp = await readAndBackup(ctx, {
          kind: 'appointment', id: args.event_id, path: `/calendars/events/appointments/${encodeURIComponent(args.event_id)}`,
        });
        backupFile = backedUp.backupFile;
        before = (backedUp.current && (backedUp.current.appointment || backedUp.current.event || backedUp.current)) || {};
      } catch (_) {
        // Blocked slots are not appointments and cannot be read back; deletion still works.
      }
      const path = `/calendars/events/${encodeURIComponent(args.event_id)}`;
      safety.gate({
        confirm: args.confirm,
        action: `delete calendar event ${args.event_id}${before.startTime ? ` at ${before.startTime}` : ''}`,
        consequence: 'The event is removed from the calendar and the contact is normally sent a cancellation.',
        request: { method: 'DELETE', path },
        accountLabel: ctx.label,
      });
      const res = await ctx.call({ method: 'DELETE', path });
      return render({ ctx, request: { method: 'DELETE', path }, data: res.data, notes: backupFile ? [`Backed up to ${backupFile}`] : ['Could not read the event first (blocked slots are not readable) — no backup was possible.'] });
    },
  }),

  tool({
    name: 'ghl_block_slot',
    title: 'Block time on a calendar',
    kind: 'write',
    description: 'Block out time on a calendar so it cannot be booked. Affects availability but does not message anyone.',
    props: {
      calendar_id: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601.' },
      end_time: { type: 'string', description: 'ISO 8601.' },
      title: { type: 'string' },
      assigned_user_id: { type: 'string' },
    },
    required: ['start_time', 'end_time'],
    handler: (args, ctx) => send(ctx, 'POST', '/calendars/events/block-slots', {
      body: {
        locationId: ctx.location(),
        startTime: args.start_time,
        endTime: args.end_time,
        ...(args.calendar_id ? { calendarId: args.calendar_id } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.assigned_user_id ? { assignedUserId: args.assigned_user_id } : {}),
      },
    }),
  }),

  tool({
    name: 'ghl_calendar_groups',
    title: 'List calendar groups',
    description: 'List calendar groups in a sub-account — the groupings that calendars belong to.',
    props: {},
    handler: (args, ctx) => get(ctx, '/calendars/groups', { locationId: ctx.location() }),
  }),
];

module.exports = tools;
