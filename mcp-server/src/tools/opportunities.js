'use strict';
// Opportunities and pipelines. Stage ids are opaque — always resolve them from
// ghl_list_pipelines rather than guessing.

const { tool, get, send, render, readAndBackup, asObject } = require('./kit');
const safety = require('../safety');

const STATUSES = ['open', 'won', 'lost', 'abandoned'];

const tools = [
  tool({
    name: 'ghl_list_pipelines',
    title: 'List pipelines and stages',
    description: 'List pipelines with their stage ids. Fetch this before creating or moving an opportunity — stage ids are not guessable and must never be hardcoded.',
    props: {},
    handler: (args, ctx) => get(ctx, '/opportunities/pipelines', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_search_opportunities',
    title: 'Search opportunities',
    description: 'Search opportunities. Note this endpoint uses snake_case query parameters; that is handled for you.',
    props: {
      pipeline_id: { type: 'string' },
      pipeline_stage_id: { type: 'string' },
      status: { type: 'string', enum: STATUSES },
      contact_id: { type: 'string' },
      assigned_to: { type: 'string', description: 'User id.' },
      query: { type: 'string', description: 'Free-text search.' },
      limit: { type: 'number', description: 'Page size (default 100).' },
      start_after_id: { type: 'string', description: 'Opportunity id to page after.' },
    },
    handler: (args, ctx) => get(ctx, '/opportunities/search', {
      location_id: ctx.location(),
      pipeline_id: args.pipeline_id,
      pipeline_stage_id: args.pipeline_stage_id,
      status: args.status,
      contact_id: args.contact_id,
      assigned_to: args.assigned_to,
      q: args.query,
      limit: args.limit || 100,
      startAfterId: args.start_after_id,
    }),
  }),

  tool({
    name: 'ghl_get_opportunity',
    title: 'Get an opportunity',
    description: 'Fetch one opportunity in full — value, stage, contact and custom fields. Do this before updating it.',
    props: { opportunity_id: { type: 'string' } },
    required: ['opportunity_id'],
    handler: (args, ctx) => get(ctx, `/opportunities/${encodeURIComponent(args.opportunity_id)}`),
  }),

  tool({
    name: 'ghl_create_opportunity',
    title: 'Create an opportunity',
    kind: 'write',
    description: 'Create an opportunity in a pipeline stage. Resolve pipeline_id and stage_id with ghl_list_pipelines first.',
    props: {
      name: { type: 'string', description: 'Opportunity name.' },
      pipeline_id: { type: 'string' },
      stage_id: { type: 'string', description: 'pipelineStageId from ghl_list_pipelines.' },
      contact_id: { type: 'string' },
      status: { type: 'string', enum: STATUSES, description: 'Default open.' },
      monetary_value: { type: 'number' },
      assigned_to: { type: 'string', description: 'User id.' },
      body: { type: 'object', description: 'Extra body fields, merged last.' },
    },
    required: ['name', 'pipeline_id'],
    handler: (args, ctx) => send(ctx, 'POST', '/opportunities/', {
      body: {
        locationId: ctx.location(),
        pipelineId: args.pipeline_id,
        name: args.name,
        status: args.status || 'open',
        ...(args.stage_id ? { pipelineStageId: args.stage_id } : {}),
        ...(args.contact_id ? { contactId: args.contact_id } : {}),
        ...(args.monetary_value !== undefined ? { monetaryValue: args.monetary_value } : {}),
        ...(args.assigned_to ? { assignedTo: args.assigned_to } : {}),
        ...(asObject(args.body, 'body') || {}),
      },
    }),
  }),

  tool({
    name: 'ghl_update_opportunity',
    title: 'Update or move an opportunity',
    kind: 'write',
    description: 'Update an opportunity, including moving it to another stage (pass stage_id). Reads and backs up the current record first.',
    props: {
      opportunity_id: { type: 'string' },
      stage_id: { type: 'string', description: 'Move to this pipelineStageId (from ghl_list_pipelines).' },
      name: { type: 'string' },
      monetary_value: { type: 'number' },
      assigned_to: { type: 'string' },
      updates: { type: 'object', description: 'Any other fields to change, merged last.' },
    },
    required: ['opportunity_id'],
    handler: async (args, ctx) => {
      const updates = {
        ...(args.stage_id ? { pipelineStageId: args.stage_id } : {}),
        ...(args.name ? { name: args.name } : {}),
        ...(args.monetary_value !== undefined ? { monetaryValue: args.monetary_value } : {}),
        ...(args.assigned_to ? { assignedTo: args.assigned_to } : {}),
        ...(asObject(args.updates, 'updates') || {}),
      };
      if (!Object.keys(updates).length) throw new Error('Nothing to update — pass stage_id, name, monetary_value, assigned_to or updates.');

      const path = `/opportunities/${encodeURIComponent(args.opportunity_id)}`;
      const { current, backupFile } = await readAndBackup(ctx, { kind: 'opportunity', id: args.opportunity_id, path });
      const before = (current && (current.opportunity || current)) || {};
      const res = await ctx.call({ method: 'PUT', path, body: updates });
      return render({
        ctx,
        request: { method: 'PUT', path },
        data: res.data,
        notes: [
          `Backed up to ${backupFile}`,
          `Was: ${JSON.stringify({ name: before.name, status: before.status, pipelineStageId: before.pipelineStageId, monetaryValue: before.monetaryValue })}`,
          'Verify with ghl_get_opportunity.',
        ],
      });
    },
  }),

  tool({
    name: 'ghl_set_opportunity_status',
    title: 'Set opportunity status',
    kind: 'write',
    description: 'Set an opportunity to open, won, lost or abandoned.',
    props: {
      opportunity_id: { type: 'string' },
      status: { type: 'string', enum: STATUSES },
    },
    required: ['opportunity_id', 'status'],
    handler: (args, ctx) => send(ctx, 'PUT', `/opportunities/${encodeURIComponent(args.opportunity_id)}/status`, {
      body: { status: args.status },
    }),
  }),

  tool({
    name: 'ghl_delete_opportunity',
    title: 'Delete an opportunity',
    kind: 'destructive',
    description: 'Delete an opportunity. Exports it first and requires explicit confirmation.',
    props: {
      opportunity_id: { type: 'string' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['opportunity_id'],
    handler: async (args, ctx) => {
      const path = `/opportunities/${encodeURIComponent(args.opportunity_id)}`;
      const { current, backupFile } = await readAndBackup(ctx, { kind: 'opportunity', id: args.opportunity_id, path });
      const o = (current && (current.opportunity || current)) || {};
      safety.gate({
        confirm: args.confirm,
        action: `delete opportunity ${args.opportunity_id} — "${o.name || '(unnamed)'}" worth ${o.monetaryValue ?? 'unknown'} in status ${o.status || 'unknown'}`,
        consequence: 'The opportunity and its stage history are removed. There is no undo.',
        request: { method: 'DELETE', path },
        accountLabel: ctx.label,
      });
      const res = await ctx.call({ method: 'DELETE', path });
      return render({ ctx, request: { method: 'DELETE', path }, data: res.data, notes: [`Exported to ${backupFile} before deletion`] });
    },
  }),

  tool({
    name: 'ghl_opportunity_followers',
    title: 'Add or remove opportunity followers',
    kind: 'write',
    description: 'Add or remove followers (users) on an opportunity.',
    props: {
      opportunity_id: { type: 'string' },
      followers: { type: 'array', items: { type: 'string' }, description: 'User ids.' },
      action: { type: 'string', enum: ['add', 'remove'], description: 'Default add.' },
    },
    required: ['opportunity_id', 'followers'],
    handler: (args, ctx) => send(
      ctx,
      args.action === 'remove' ? 'DELETE' : 'POST',
      `/opportunities/${encodeURIComponent(args.opportunity_id)}/followers`,
      { body: { followers: args.followers } },
    ),
  }),
];

module.exports = tools;
