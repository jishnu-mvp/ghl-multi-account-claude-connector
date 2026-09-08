'use strict';
// Workflows and campaigns. Enrolment fires live automations — every write here is gated.

const { tool, get, send } = require('./kit');
const safety = require('../safety');

const tools = [
  tool({
    name: 'ghl_list_workflows',
    title: 'List workflows',
    description: 'List the workflows in a sub-account with their ids. Read-only: the API cannot author workflows, that stays a UI job.',
    props: {},
    handler: (args, ctx) => get(ctx, '/workflows/', { locationId: ctx.location() }),
  }),

  tool({
    name: 'ghl_add_to_workflow',
    title: 'Enrol a contact in a workflow',
    kind: 'outbound',
    description:
      'Enrol a contact in a workflow. This FIRES LIVE AUTOMATIONS — messages, tasks and internal ' +
      'notifications can all go out as a result. Requires explicit user confirmation.',
    props: {
      contact_id: { type: 'string' },
      workflow_id: { type: 'string', description: 'From ghl_list_workflows — never a guessed id.' },
      event_start_time: { type: 'string', description: 'ISO 8601 start time for the enrolment (optional).' },
      confirm: { type: 'boolean', description: 'Must be true to enrol.' },
    },
    required: ['contact_id', 'workflow_id'],
    handler: async (args, ctx) => {
      const path = `/contacts/${encodeURIComponent(args.contact_id)}/workflow/${encodeURIComponent(args.workflow_id)}`;
      const body = args.event_start_time ? { eventStartTime: args.event_start_time } : {};

      let workflowName = args.workflow_id;
      try {
        const list = await ctx.call({ method: 'GET', path: '/workflows/', query: { locationId: ctx.location() } });
        const found = ((list.data && list.data.workflows) || []).find((w) => (w.id || w._id) === args.workflow_id);
        if (found) workflowName = `${found.name} (${args.workflow_id})`;
      } catch (_) { /* the id alone is enough for the dry run */ }

      safety.gate({
        confirm: args.confirm,
        action: `enrol contact ${args.contact_id} in workflow ${workflowName}`,
        consequence: 'The workflow starts running for this contact — any messages, tasks or notifications in it will fire for real.',
        request: { method: 'POST', path, body },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body });
    },
  }),

  tool({
    name: 'ghl_remove_from_workflow',
    title: 'Remove a contact from a workflow',
    kind: 'write',
    description: 'Remove a contact from a workflow, stopping any pending steps. Requires confirmation because it changes what the contact will receive.',
    props: {
      contact_id: { type: 'string' },
      workflow_id: { type: 'string' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['contact_id', 'workflow_id'],
    handler: async (args, ctx) => {
      const path = `/contacts/${encodeURIComponent(args.contact_id)}/workflow/${encodeURIComponent(args.workflow_id)}`;
      safety.gate({
        confirm: args.confirm,
        action: `remove contact ${args.contact_id} from workflow ${args.workflow_id}`,
        consequence: 'Pending workflow steps for this contact stop. Anything already sent stays sent.',
        request: { method: 'DELETE', path },
        accountLabel: ctx.label,
      });
      return send(ctx, 'DELETE', path);
    },
  }),

  tool({
    name: 'ghl_list_campaigns',
    title: 'List campaigns',
    description: 'List campaigns in a sub-account.',
    props: { status: { type: 'string', description: 'Filter by status (e.g. published, draft).' } },
    handler: (args, ctx) => get(ctx, '/campaigns/', { locationId: ctx.location(), status: args.status }),
  }),

  tool({
    name: 'ghl_add_to_campaign',
    title: 'Add a contact to a campaign',
    kind: 'outbound',
    description: 'Add a contact to a campaign. Campaigns SEND REAL MESSAGES. Requires explicit user confirmation.',
    props: {
      contact_id: { type: 'string' },
      campaign_id: { type: 'string', description: 'From ghl_list_campaigns.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['contact_id', 'campaign_id'],
    handler: async (args, ctx) => {
      const path = `/contacts/${encodeURIComponent(args.contact_id)}/campaigns/${encodeURIComponent(args.campaign_id)}`;
      safety.gate({
        confirm: args.confirm,
        action: `add contact ${args.contact_id} to campaign ${args.campaign_id}`,
        consequence: 'The campaign starts contacting this person for real.',
        request: { method: 'POST', path, body: {} },
        accountLabel: ctx.label,
      });
      return send(ctx, 'POST', path, { body: {} });
    },
  }),

  tool({
    name: 'ghl_remove_from_campaign',
    title: 'Remove a contact from a campaign',
    kind: 'write',
    description: 'Remove a contact from one campaign, or from all of them.',
    props: {
      contact_id: { type: 'string' },
      campaign_id: { type: 'string', description: 'Omit together with all: true to remove from every campaign.' },
      all: { type: 'boolean', description: 'Remove from all campaigns.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    required: ['contact_id'],
    handler: async (args, ctx) => {
      if (!args.campaign_id && args.all !== true) {
        throw new Error('Give a campaign_id, or pass all: true to remove the contact from every campaign.');
      }
      const path = args.all === true && !args.campaign_id
        ? `/contacts/${encodeURIComponent(args.contact_id)}/campaigns/removeAll`
        : `/contacts/${encodeURIComponent(args.contact_id)}/campaigns/${encodeURIComponent(args.campaign_id)}`;
      safety.gate({
        confirm: args.confirm,
        action: args.all && !args.campaign_id
          ? `remove contact ${args.contact_id} from ALL campaigns`
          : `remove contact ${args.contact_id} from campaign ${args.campaign_id}`,
        consequence: 'Pending campaign messages to this contact stop.',
        request: { method: 'DELETE', path },
        accountLabel: ctx.label,
      });
      return send(ctx, 'DELETE', path);
    },
  }),
];

module.exports = tools;
