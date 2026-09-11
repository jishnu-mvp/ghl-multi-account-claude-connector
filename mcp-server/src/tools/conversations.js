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
// Conversations and messaging. Everything that sends is confirmation-gated: a message here
// reaches a real person's phone or inbox and cannot be recalled.

const { tool, get, send, asObject } = require('./kit');
const safety = require('../safety');

const MESSAGE_TYPES = ['SMS', 'Email', 'WhatsApp', 'IG', 'FB', 'Custom', 'Live_Chat'];

const tools = [
  tool({
    name: 'ghl_list_conversations',
    title: 'List conversations',
    description: 'Search conversations in a sub-account, optionally narrowed to one contact.',
    props: {
      contact_id: { type: 'string', description: 'Only this contact\'s conversations.' },
      query: { type: 'string', description: 'Free-text search.' },
      status: { type: 'string', description: 'e.g. unread, starred, recents, all.' },
      limit: { type: 'number', description: 'Page size (default 20).' },
    },
    handler: (args, ctx) => get(ctx, '/conversations/search', {
      locationId: ctx.location(),
      contactId: args.contact_id,
      query: args.query,
      status: args.status,
      limit: args.limit,
    }),
  }),

  tool({
    name: 'ghl_get_conversation',
    title: 'Get a conversation',
    description: 'Fetch one conversation by id: which contact it belongs to, its channel and unread state.',
    props: { conversation_id: { type: 'string' } },
    required: ['conversation_id'],
    handler: (args, ctx) => get(ctx, `/conversations/${encodeURIComponent(args.conversation_id)}`),
  }),

  tool({
    name: 'ghl_conversation_messages',
    title: 'Conversation history',
    description: 'Read a conversation\'s message history. Contains personal data — summarise it, do not paste it anywhere outside this conversation.',
    props: {
      conversation_id: { type: 'string' },
      limit: { type: 'number', description: 'How many messages (default 20).' },
      last_message_id: { type: 'string', description: 'Page backwards from this message id.' },
    },
    required: ['conversation_id'],
    handler: (args, ctx) => get(ctx, `/conversations/${encodeURIComponent(args.conversation_id)}/messages`, {
      limit: args.limit,
      lastMessageId: args.last_message_id,
    }),
  }),

  tool({
    name: 'ghl_get_message',
    title: 'Get a message',
    description: 'Fetch a single message by id, including its delivery status. Useful after sending one.',
    props: { message_id: { type: 'string' } },
    required: ['message_id'],
    handler: (args, ctx) => get(ctx, `/conversations/messages/${encodeURIComponent(args.message_id)}`),
  }),

  tool({
    name: 'ghl_create_conversation',
    title: 'Start a conversation',
    kind: 'write',
    description: 'Open a conversation thread with a contact. Does not send anything on its own.',
    props: { contact_id: { type: 'string' } },
    required: ['contact_id'],
    handler: (args, ctx) => send(ctx, 'POST', '/conversations/', {
      body: { locationId: ctx.location(), contactId: args.contact_id },
    }),
  }),

  tool({
    name: 'ghl_send_message',
    title: 'Send a message to a contact',
    kind: 'outbound',
    description:
      'SENDS A REAL MESSAGE to a contact (SMS, email, WhatsApp, …). Requires explicit user ' +
      'confirmation: call once without confirm to get the exact dry run, show it to the user, and ' +
      'only pass confirm: true after they say yes. Never test this against a real customer.',
    props: {
      type: { type: 'string', enum: MESSAGE_TYPES, description: 'Channel to send on.' },
      contact_id: { type: 'string', description: 'Recipient contact id.' },
      message: { type: 'string', description: 'Message body (plain text).' },
      subject: { type: 'string', description: 'Email subject (Email only).' },
      html: { type: 'string', description: 'HTML body (Email only).' },
      email_from: { type: 'string', description: 'From address (Email only); must be a verified sender in HighLevel.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'URLs of attachments.' },
      conversation_id: { type: 'string', description: 'Send inside an existing conversation.' },
      scheduled_timestamp: { type: 'number', description: 'Epoch seconds to send later instead of now.' },
      body: { type: 'object', description: 'Extra body fields, merged last.' },
      confirm: { type: 'boolean', description: 'Must be true to actually send.' },
    },
    required: ['type', 'contact_id'],
    handler: async (args, ctx) => {
      const payload = {
        type: args.type,
        contactId: args.contact_id,
        ...(args.message ? { message: args.message } : {}),
        ...(args.subject ? { subject: args.subject } : {}),
        ...(args.html ? { html: args.html } : {}),
        ...(args.email_from ? { emailFrom: args.email_from } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
        ...(args.conversation_id ? { conversationId: args.conversation_id } : {}),
        ...(args.scheduled_timestamp ? { scheduledTimestamp: args.scheduled_timestamp } : {}),
        ...(asObject(args.body, 'body') || {}),
      };
      if (!payload.message && !payload.html) {
        throw new Error('Nothing to send — provide `message` (or `html` for an email).');
      }

      // Name the recipient in the dry run so nobody confirms a send to the wrong person.
      let who = args.contact_id;
      try {
        const probe = await ctx.call({ method: 'GET', path: `/contacts/${encodeURIComponent(args.contact_id)}` });
        const c = (probe.data && (probe.data.contact || probe.data)) || {};
        who = `${[c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)'} · ${c.email || 'no email'} · ${c.phone || 'no phone'} (${args.contact_id})`;
      } catch (_) { /* the dry run is still worth showing without it */ }

      safety.gate({
        confirm: args.confirm,
        action: `send a ${args.type} to ${who}`,
        consequence: args.scheduled_timestamp
          ? 'The message is queued and will be delivered to a real person at the scheduled time.'
          : 'A real person receives this message immediately. It cannot be recalled.',
        request: { method: 'POST', path: '/conversations/messages', body: payload },
        accountLabel: ctx.label,
      });

      return send(ctx, 'POST', '/conversations/messages', {
        body: payload,
        notes: ['Sent. Check delivery with ghl_get_message on the returned messageId.'],
      });
    },
  }),

  tool({
    name: 'ghl_record_inbound_message',
    title: 'Record an inbound message',
    kind: 'write',
    description: 'Log a message that arrived elsewhere into the HighLevel conversation. Nothing is sent to the contact.',
    props: {
      type: { type: 'string', enum: MESSAGE_TYPES, description: 'Channel the message arrived on.' },
      conversation_id: { type: 'string' },
      message: { type: 'string' },
      body: { type: 'object', description: 'Extra body fields, merged last.' },
    },
    required: ['type', 'conversation_id'],
    handler: (args, ctx) => send(ctx, 'POST', '/conversations/messages/inbound', {
      body: {
        type: args.type,
        conversationId: args.conversation_id,
        ...(args.message ? { message: args.message } : {}),
        ...(asObject(args.body, 'body') || {}),
      },
    }),
  }),

  tool({
    name: 'ghl_email_delivery_detail',
    title: 'Email delivery detail',
    description: 'Delivery detail for one email message (opens, bounces, provider response).',
    props: { message_id: { type: 'string' } },
    required: ['message_id'],
    handler: (args, ctx) => get(ctx, `/conversations/providers/email/${encodeURIComponent(args.message_id)}`),
  }),
];

module.exports = tools;
