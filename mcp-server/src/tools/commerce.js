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
// Products, invoices and payments. Note the query-parameter trap on this family of
// endpoints: they take altId/altType rather than locationId.

const { tool, get, send, asObject } = require('./kit');
const safety = require('../safety');

const tools = [
  tool({
    name: 'ghl_list_products',
    title: 'List products',
    description: 'List the products in a sub-account with their ids, for invoices and order lookups.',
    props: { limit: { type: 'number' }, offset: { type: 'number' }, search: { type: 'string' } },
    handler: (args, ctx) => get(ctx, '/products/', {
      locationId: ctx.location(), limit: args.limit, offset: args.offset, search: args.search,
    }),
  }),

  tool({
    name: 'ghl_get_product',
    title: 'Get a product',
    description: 'Fetch one product in full, including its description and variants.',
    props: { product_id: { type: 'string' } },
    required: ['product_id'],
    handler: (args, ctx) => get(ctx, `/products/${encodeURIComponent(args.product_id)}`, { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_product_prices',
    title: 'List product prices',
    description: 'List the prices configured for a product, with the price ids invoices refer to.',
    props: { product_id: { type: 'string' } },
    required: ['product_id'],
    handler: (args, ctx) => get(ctx, `/products/${encodeURIComponent(args.product_id)}/price`, { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_list_invoices',
    title: 'List invoices',
    description: 'List invoices for a sub-account, optionally filtered by status or contact.',
    props: {
      limit: { type: 'number', description: 'Default 100.' },
      offset: { type: 'number', description: 'Default 0.' },
      status: { type: 'string', description: 'e.g. draft, sent, paid, void.' },
      contact_id: { type: 'string' },
    },
    handler: (args, ctx) => get(ctx, '/invoices/', {
      altId: ctx.location(),
      altType: 'location',
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
      status: args.status,
      contactId: args.contact_id,
    }),
  }),

  tool({
    name: 'ghl_get_invoice',
    title: 'Get an invoice',
    description: 'Fetch one invoice in full, including line items and payment status.',
    props: { invoice_id: { type: 'string' } },
    required: ['invoice_id'],
    handler: (args, ctx) => get(ctx, `/invoices/${encodeURIComponent(args.invoice_id)}`, { altId: ctx.location(), altType: 'location' }),
  }),

  tool({
    name: 'ghl_send_invoice',
    title: 'Send an invoice',
    kind: 'outbound',
    description: 'SENDS AN INVOICE to the customer by email/SMS and asks them for money. Requires explicit user confirmation.',
    props: {
      invoice_id: { type: 'string' },
      body: { type: 'object', description: 'Send options HighLevel supports (action, userId, liveMode, sendTo, …).' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['invoice_id'],
    handler: async (args, ctx) => {
      const path = `/invoices/${encodeURIComponent(args.invoice_id)}/send`;
      const body = { altId: ctx.location(), altType: 'location', ...(asObject(args.body, 'body') || {}) };

      let summary = args.invoice_id;
      try {
        const probe = await ctx.call({ method: 'GET', path: `/invoices/${encodeURIComponent(args.invoice_id)}`, query: { altId: ctx.location(), altType: 'location' } });
        const inv = (probe.data && (probe.data.invoice || probe.data)) || {};
        summary = `#${inv.invoiceNumber || args.invoice_id} for ${inv.total ?? '?'} ${inv.currency || ''} to ${(inv.contactDetails && (inv.contactDetails.email || inv.contactDetails.name)) || 'the customer'}`;
      } catch (_) { /* the dry run still shows the request */ }

      safety.gate({
        confirm: args.confirm,
        action: `send invoice ${summary}`,
        consequence: 'The customer receives a real invoice and a request for payment.',
        request: { method: 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_void_invoice',
    title: 'Void an invoice',
    kind: 'destructive',
    description: 'Void an invoice. Financial record change — requires explicit confirmation.',
    props: {
      invoice_id: { type: 'string' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['invoice_id'],
    handler: async (args, ctx) => {
      const path = `/invoices/${encodeURIComponent(args.invoice_id)}/void`;
      const body = { altId: ctx.location(), altType: 'location' };
      safety.gate({
        confirm: args.confirm,
        action: `void invoice ${args.invoice_id}`,
        consequence: 'The invoice is cancelled in the customer\'s billing history. Accounting will see this.',
        request: { method: 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_record_invoice_payment',
    title: 'Record a payment on an invoice',
    kind: 'write',
    description: 'Record a manual payment against an invoice. Financial record change — requires confirmation.',
    props: {
      invoice_id: { type: 'string' },
      body: { type: 'object', description: 'Payment details HighLevel expects (mode, amount, notes, paymentSchedule, …).' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['invoice_id', 'body'],
    handler: async (args, ctx) => {
      const path = `/invoices/${encodeURIComponent(args.invoice_id)}/record-payment`;
      const body = { altId: ctx.location(), altType: 'location', ...(asObject(args.body, 'body') || {}) };
      safety.gate({
        confirm: args.confirm,
        action: `record a payment on invoice ${args.invoice_id}`,
        consequence: 'The invoice is marked (part-)paid and the customer may be receipted.',
        request: { method: 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_list_orders',
    title: 'List orders',
    description: 'List payment orders for a sub-account (completed purchases).',
    props: { limit: { type: 'number' }, offset: { type: 'number' }, contact_id: { type: 'string' } },
    handler: (args, ctx) => get(ctx, '/payments/orders', {
      altId: ctx.location(), altType: 'location', limit: args.limit, offset: args.offset, contactId: args.contact_id,
    }),
  }),

  tool({
    name: 'ghl_get_order',
    title: 'Get an order',
    description: 'Fetch one payment order in full, including its line items.',
    props: { order_id: { type: 'string' } },
    required: ['order_id'],
    handler: (args, ctx) => get(ctx, `/payments/orders/${encodeURIComponent(args.order_id)}`, { altId: ctx.location(), altType: 'location' }),
  }),

  tool({
    name: 'ghl_list_transactions',
    title: 'List transactions',
    description: 'List payment transactions for a sub-account (individual charges and refunds).',
    props: { limit: { type: 'number' }, offset: { type: 'number' }, contact_id: { type: 'string' } },
    handler: (args, ctx) => get(ctx, '/payments/transactions', {
      altId: ctx.location(), altType: 'location', limit: args.limit, offset: args.offset, contactId: args.contact_id,
    }),
  }),

  tool({
    name: 'ghl_list_subscriptions',
    title: 'List subscriptions',
    description: 'List recurring subscriptions for a sub-account, with their status and next charge.',
    props: { limit: { type: 'number' }, offset: { type: 'number' }, contact_id: { type: 'string' } },
    handler: (args, ctx) => get(ctx, '/payments/subscriptions', {
      altId: ctx.location(), altType: 'location', limit: args.limit, offset: args.offset, contactId: args.contact_id,
    }),
  }),
];

module.exports = tools;
