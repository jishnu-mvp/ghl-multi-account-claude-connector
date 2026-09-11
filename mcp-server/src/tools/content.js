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
// Funnels, trigger links, businesses, media, email templates, blogs, social planner.

const { tool, get, send, asObject } = require('./kit');

const tools = [
  tool({
    name: 'ghl_list_funnels',
    title: 'List funnels',
    description: 'List the funnels in a sub-account with their ids.',
    props: {},
    handler: (args, ctx) => get(ctx, '/funnels/funnel/list', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_list_funnel_pages',
    title: 'List funnel pages',
    description: 'List the pages inside one funnel, with their paths and ids.',
    props: { funnel_id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
    required: ['funnel_id'],
    handler: (args, ctx) => get(ctx, '/funnels/page', {
      locationId: ctx.location(), funnelId: args.funnel_id, limit: args.limit, offset: args.offset,
    }),
  }),

  tool({
    name: 'ghl_list_links',
    title: 'List trigger links',
    description: 'List trigger links in a sub-account (the trackable redirects used in messages).',
    props: {},
    handler: (args, ctx) => get(ctx, '/links/', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_create_link',
    title: 'Create a trigger link',
    kind: 'write',
    description: 'Create a trigger link: a trackable redirect that can start an automation when clicked.',
    props: {
      name: { type: 'string' },
      redirect_to: { type: 'string', description: 'Destination URL.' },
    },
    required: ['name', 'redirect_to'],
    handler: (args, ctx) => send(ctx, 'POST', '/links/', {
      body: { locationId: ctx.location(), name: args.name, redirectTo: args.redirect_to },
    }),
  }),

  tool({
    name: 'ghl_list_businesses',
    title: 'List businesses',
    description: 'Business records (the company objects contacts can belong to) in the sub-account.',
    props: {},
    handler: (args, ctx) => get(ctx, '/businesses/', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_get_business',
    title: 'Get a business',
    description: 'Fetch one business record in full — the company object contacts can be attached to.',
    props: { business_id: { type: 'string' } },
    required: ['business_id'],
    handler: (args, ctx) => get(ctx, `/businesses/${encodeURIComponent(args.business_id)}`),
  }),

  tool({
    name: 'ghl_list_media',
    title: 'List media files',
    description: 'The media library. Note this endpoint uses altId/altType rather than locationId.',
    props: {
      limit: { type: 'number' },
      offset: { type: 'number' },
      sort_by: { type: 'string', description: 'e.g. createdAt, name.' },
      sort_order: { type: 'string', enum: ['asc', 'desc'] },
      query: { type: 'string', description: 'Search by file name.' },
    },
    handler: (args, ctx) => get(ctx, '/medias/files', {
      altId: ctx.location(),
      altType: 'location',
      limit: args.limit,
      offset: args.offset,
      sortBy: args.sort_by,
      sortOrder: args.sort_order,
      query: args.query,
    }),
  }),

  tool({
    name: 'ghl_list_email_templates',
    title: 'List email templates',
    description: 'Email builder templates in the sub-account.',
    props: { limit: { type: 'number' }, offset: { type: 'number' } },
    handler: (args, ctx) => get(ctx, '/emails/builder', { locationId: ctx.location(), limit: args.limit, offset: args.offset }),
  }),

  tool({
    name: 'ghl_list_blog_sites',
    title: 'List blog sites',
    description: 'List the blog sites in a sub-account, with the blog ids posts belong to.',
    props: { limit: { type: 'number' }, skip: { type: 'number' } },
    handler: (args, ctx) => get(ctx, '/blogs/site/all', {
      locationId: ctx.location(), limit: args.limit ?? 50, skip: args.skip ?? 0,
    }),
  }),

  tool({
    name: 'ghl_list_blog_posts',
    title: 'List blog posts',
    description: 'List the posts on one blog site, with their status and URLs.',
    props: {
      blog_id: { type: 'string' },
      limit: { type: 'number' },
      skip: { type: 'number' },
    },
    required: ['blog_id'],
    handler: (args, ctx) => get(ctx, '/blogs/posts/all', {
      locationId: ctx.location(), blogId: args.blog_id, limit: args.limit ?? 50, skip: args.skip ?? 0,
    }),
  }),

  tool({
    name: 'ghl_list_social_posts',
    title: 'List social planner posts',
    description: 'Social planner posts for the sub-account.',
    props: {
      limit: { type: 'number', description: 'Default 20.' },
      skip: { type: 'number' },
      body: { type: 'object', description: 'Extra filters HighLevel supports (type, accounts, fromDate, toDate, …).' },
    },
    handler: (args, ctx) => send(ctx, 'POST', `/social-media-posting/${encodeURIComponent(ctx.location())}/posts/list`, {
      body: { limit: args.limit ?? 20, skip: args.skip ?? 0, ...(asObject(args.body, 'body') || {}) },
    }),
  }),

  tool({
    name: 'ghl_list_social_accounts',
    title: 'List connected social accounts',
    description: 'Social accounts connected to the sub-account\'s social planner.',
    props: {},
    handler: (args, ctx) => get(ctx, `/social-media-posting/${encodeURIComponent(ctx.location())}/accounts`),
  }),
];

module.exports = tools;
