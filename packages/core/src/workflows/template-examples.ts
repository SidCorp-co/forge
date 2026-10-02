/**
 * One tiny design per built-in template, served beside it (`GET /api/workflow-templates/:id/:version`)
 * so an agent builder copies a shape that is accepted rather than guessing one. Each is held to its
 * template by `templates.test.ts`, so an example that stops passing fails there by name.
 */

import { WORKFLOW_V2_SCHEMA_ID, type WorkflowWriteV2 } from './schema.js';

const EXAMPLE_PROJECT = '00000000-0000-4000-8000-000000000000';

const head = (
  flow: string,
  kind: 'flow' | 'state',
  title: string,
  summary: string,
  id: string,
) => ({
  $schema: WORKFLOW_V2_SCHEMA_ID as WorkflowWriteV2['$schema'],
  version: 2 as const,
  project: EXAMPLE_PROJECT,
  flow,
  kind,
  title,
  summary,
  status: 'designed' as const,
  template: { id, version: 1 },
  drift: null,
  writtenBy: {},
  refreshedAtSha: null,
});

const step = (
  id: string,
  does: string,
  after: string[],
  node: WorkflowWriteV2['steps'][number]['node'],
) => ({
  id,
  does,
  status: 'designed' as const,
  after,
  evidence: null,
  ...(node ? { node } : {}),
});

const journey: WorkflowWriteV2 = {
  ...head(
    'post-discharge',
    'flow',
    'Post-discharge follow-up',
    'A high-risk discharge becomes one case with an owner, and the result re-checks the rule.',
    'journey-bands',
  ),
  steps: [
    step('discharged', 'patient.discharged arrives from the HIS.', [], {
      type: 'EVENT',
      label: 'Patient discharged',
      outputs: ['patient.id', 'episode.id'],
    }),
    step('context', 'The episode risk and care team are read.', ['discharged'], {
      type: 'CONTEXT',
      label: 'Know the patient',
      inputs: ['episode.id'],
      outputs: ['episode.risk'],
    }),
    step('followup-rule', 'A high-risk discharge needs follow-up within 48 hours.', ['context'], {
      type: 'RULE',
      label: 'Decide follow-up',
      inputs: ['episode.risk'],
      conditions: [{ when: 'episode.risk == high', result: 'follow-up required' }],
      outputs: ['followup_required'],
      tests: ['high risk → required', 'low risk → not required'],
    }),
    step('call', 'The coordinator calls the patient.', ['followup-rule'], {
      type: 'TASK',
      label: 'Call the patient',
      owner: 'care coordinator',
      sla: '48h',
      expectedOutcome: 'patient reached and follow-up agreed',
      permissions: ['read episode', 'book appointment'],
    }),
    step('late', 'An overdue call is raised to the lead.', ['call'], {
      type: 'ATTENTION',
      label: 'Flag what is late',
      conditions: [{ when: 'call overdue', result: 'raise to lead' }],
      owner: 'care lead',
    }),
    step('outcome', 'The call is recorded as reached or unreachable.', ['call'], {
      type: 'OUTCOME',
      label: 'Record the result',
      outputs: ['call.outcome'],
    }),
    step('recheck', 'The rule is run again on the updated journey.', ['outcome'], {
      type: 'RULE',
      band: 'feedback',
      label: 'Re-check the rules',
      inputs: ['call.outcome'],
      conditions: [{ when: 'call.outcome == reached', result: 'case can close' }],
      outputs: ['case.closable'],
      tests: ['reached → closable'],
    }),
  ],
  edges: [
    { kind: 'escalation', from: 'call', to: 'late', condition: 'call not made within 48h' },
    {
      kind: 'feedback',
      from: 'recheck',
      to: 'followup-rule',
      reevaluates: 'follow-up rule against the updated journey',
      condition: 'a rule input changed',
      action: 're-run follow-up rule',
      mapping: { episode_id: 'episode.id' },
      idempotency: 'one re-evaluation per outcome',
      onFailure: 'create_attention_item',
    },
  ],
};

const lifecycle: WorkflowWriteV2 = {
  ...head(
    'order-status',
    'state',
    'Order status',
    'An order is placed, paid, shipped and delivered; a failed payment returns it to placed.',
    'state-machine',
  ),
  steps: [
    step('placed', 'The order exists and awaits payment.', [], {
      type: 'STATE',
      purpose: 'Awaiting payment.',
      initial: true,
    }),
    step('paid', 'Payment is captured.', ['placed'], {
      type: 'STATE',
      purpose: 'Paid, awaiting shipment.',
    }),
    step('shipped', 'The parcel left the warehouse.', ['paid'], {
      type: 'STATE',
      purpose: 'In transit.',
    }),
    step('delivered', 'The customer has it.', ['shipped'], {
      type: 'STATE',
      purpose: 'Done.',
      terminal: true,
    }),
  ],
  edges: [
    { from: 'placed', to: 'paid', condition: 'payment captured' },
    { from: 'paid', to: 'shipped', condition: 'label printed' },
    { from: 'shipped', to: 'delivered', condition: 'carrier confirms delivery' },
    { kind: 'back', from: 'shipped', to: 'placed', condition: 'payment charged back' },
  ],
};

const swimlanes: WorkflowWriteV2 = {
  ...head(
    'leave-request',
    'flow',
    'Leave request',
    'An employee asks for leave, the manager decides, HR records it.',
    'process-swimlanes',
  ),
  lanes: [
    { id: 'employee', label: 'Employee' },
    { id: 'manager', label: 'Manager' },
    { id: 'hr', label: 'HR' },
  ],
  steps: [
    step('ask', 'The employee submits dates.', [], {
      type: 'START',
      band: 'employee',
      label: 'Ask for leave',
    }),
    step('decide', 'The manager approves or declines.', ['ask'], {
      type: 'GATEWAY',
      band: 'manager',
      label: 'Approve?',
      conditions: [
        { when: 'team covered', result: 'approve' },
        { when: 'otherwise', result: 'decline' },
      ],
    }),
    step('record', 'HR records the approved leave.', ['decide'], {
      type: 'TASK',
      band: 'hr',
      label: 'Record leave',
      expectedOutcome: 'leave in the HR system',
    }),
    step('done', 'The employee is told.', ['record'], {
      type: 'END',
      band: 'employee',
      label: 'Told',
    }),
  ],
  edges: [{ kind: 'message', from: 'ask', to: 'decide', action: 'notify manager' }],
};

const sequence: WorkflowWriteV2 = {
  ...head(
    'his-discharge-intake',
    'flow',
    'HIS discharge intake',
    'HIS sends a discharge; HOP checks, stores and acknowledges it.',
    'integration-sequence',
  ),
  lanes: [
    { id: 'his', label: 'HIS' },
    { id: 'hop', label: 'HOP' },
  ],
  steps: [
    step('send', 'HIS posts patient.discharged.', [], {
      type: 'SEND',
      band: 'his',
      outputs: ['event_id', 'encounter_id'],
    }),
    step('receive', 'HOP checks the signature and the event id.', ['send'], {
      type: 'RECEIVE',
      band: 'hop',
      inputs: ['event_id', 'encounter_id'],
    }),
    step('store', 'HOP stores the message once per event id.', ['receive'], {
      type: 'STORE',
      band: 'hop',
      outputs: ['hop_discharge_events row'],
    }),
    step('ack', 'HOP answers 202.', ['store'], {
      type: 'RESPOND',
      band: 'hop',
      outputs: ['202 accepted'],
    }),
  ],
  edges: [
    {
      kind: 'message',
      from: 'send',
      to: 'receive',
      label: 'discharge sent',
      mapping: { event_id: 'event_id', encounter_id: 'encounter_id' },
      idempotency: 'one row per HIS event_id',
      onFailure: 'HIS retries with backoff',
    },
  ],
};

const tree: WorkflowWriteV2 = {
  ...head(
    'follow-up-eligibility',
    'flow',
    'Follow-up eligibility',
    'Whether a discharged patient is called, and how urgently.',
    'decision-tree',
  ),
  steps: [
    step('surgery', 'Did the patient have surgery?', [], {
      type: 'QUESTION',
      inputs: ['episode.procedures'],
      conditions: [
        { when: 'surgery', result: 'urgency' },
        { when: 'no surgery', result: 'no call' },
      ],
    }),
    step('urgency', 'How urgent is the call?', ['surgery'], {
      type: 'TABLE',
      inputs: ['patient.vip', 'episode.risk'],
      conditions: [
        { when: 'vip or high risk', result: 'call within 4h' },
        { when: 'otherwise', result: 'call within 24h' },
      ],
      outputs: ['call.sla'],
      tests: ['vip → 4h', 'low risk → 24h'],
    }),
    step('no-call', 'No follow-up call.', ['surgery'], {
      type: 'DECISION',
      outputs: ['followup = none'],
    }),
  ],
  edges: [
    { from: 'surgery', to: 'urgency', condition: 'had surgery' },
    { from: 'surgery', to: 'no-call', condition: 'no surgery' },
  ],
};

const lineage: WorkflowWriteV2 = {
  ...head(
    'discharge-metrics',
    'flow',
    'Discharge metrics',
    'Discharge events become the daily follow-up rate on the ops dashboard.',
    'data-lineage',
  ),
  steps: [
    step('events', 'HIS discharge events.', [], {
      type: 'SOURCE',
      outputs: ['event_id', 'discharged_at'],
      owner: 'HIS team',
    }),
    step('daily', 'Events rolled up per day.', ['events'], {
      type: 'TRANSFORM',
      inputs: ['discharged_at'],
      outputs: ['day', 'discharges'],
    }),
    step('mart', 'The ops mart table.', ['daily'], {
      type: 'STORE',
      inputs: ['day', 'discharges'],
      owner: 'data team',
    }),
    step('dashboard', 'The ops dashboard reads it.', ['mart'], {
      type: 'CONSUMER',
      inputs: ['discharges'],
    }),
  ],
  edges: [
    { from: 'events', to: 'daily', mapping: { day: 'date(discharged_at)' } },
    { from: 'daily', to: 'mart', mapping: { day: 'day', discharges: 'count' } },
    { from: 'mart', to: 'dashboard', mapping: { discharges: 'discharges' } },
  ],
};

const ux: WorkflowWriteV2 = {
  ...head(
    'book-follow-up-ui',
    'flow',
    'Book a follow-up',
    'A coordinator opens the patient, books a follow-up slot, and sees it confirmed.',
    'ux-flow',
  ),
  personas: [{ id: 'coordinator', label: 'Care coordinator' }],
  steps: [
    step('patient', 'The coordinator opens the patient card.', [], {
      type: 'SCREEN',
      band: 'arrive',
      label: 'Patient card',
      purpose: 'See who to call and why.',
      persona: 'coordinator',
      dataShown: ['name', 'risk', 'discharged at'],
      actions: ['book follow-up'],
    }),
    step('load-failed', 'The card could not load.', ['patient'], {
      type: 'UI_STATE',
      variant: 'error',
      label: 'Could not load',
    }),
    step('pick-slot', 'The coordinator picks a slot and confirms.', ['patient'], {
      type: 'USER_ACTION',
      label: 'Pick a slot',
      trigger: 'press Book',
      validation: 'a slot is chosen and in the future',
    }),
    step('book', 'The booking is written.', ['pick-slot'], {
      type: 'SYSTEM_STEP',
      label: 'Book the appointment',
      invokes: { workflow: 'post-discharge', step: 'call' },
    }),
    step('booked', 'The confirmation is shown.', ['book'], {
      type: 'SCREEN',
      band: 'result',
      label: 'Booked',
      purpose: 'Confirm the booking.',
      persona: 'coordinator',
      dataShown: ['slot', 'clinic'],
      actions: ['done'],
      noErrorState: 'a static confirmation with nothing to load',
    }),
    step('slot-taken', 'The slot was taken meanwhile.', ['book'], {
      type: 'UI_STATE',
      band: 'result',
      variant: 'error',
      label: 'Slot taken',
    }),
  ],
  edges: [
    { kind: 'error', from: 'patient', to: 'load-failed', condition: 'the patient read fails' },
    {
      kind: 'submit',
      from: 'pick-slot',
      to: 'book',
      payload: ['patient_id', 'slot_id'],
      success: 'booked',
      failure: 'slot-taken',
    },
    { kind: 'error', from: 'book', to: 'slot-taken', condition: 'the slot is no longer free' },
  ],
};

export const TEMPLATE_EXAMPLES: Readonly<Record<string, WorkflowWriteV2>> = {
  'journey-bands@1': journey,
  'state-machine@1': lifecycle,
  'process-swimlanes@1': swimlanes,
  'integration-sequence@1': sequence,
  'decision-tree@1': tree,
  'data-lineage@1': lineage,
  'ux-flow@1': ux,
};
