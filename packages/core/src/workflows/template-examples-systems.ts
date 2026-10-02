/** The examples of the state-machine templates and of the systems-and-data templates (`template-examples.ts`). */

import type { WorkflowWriteV2 } from './schema.js';
import { head, lane, ref, step } from './template-example-kit.js';

const lifecycle = (
  flow: string,
  template: string,
  title: string,
  codes: { open?: string; working?: string; closed?: string },
): WorkflowWriteV2 => ({
  ...head(
    flow,
    'state',
    title,
    'A follow-up case opens, is worked, and closes; more information reopens it.',
    template,
  ),
  steps: [
    step('start', 'The machine starts.', [], { type: 'INITIAL' }),
    step('open', 'The case waits for a coordinator.', ['start'], {
      type: 'STATE',
      label: 'Open',
      ...(codes.open ? { mapsTo: codes.open } : {}),
    }),
    step('working', 'A coordinator works the case.', ['open'], {
      type: 'STATE',
      label: 'In progress',
      ...(codes.working ? { mapsTo: codes.working } : {}),
    }),
    step('closed', 'The case is closed on its outcome.', ['working'], {
      type: 'FINAL',
      label: 'Closed',
      ...(codes.closed ? { mapsTo: codes.closed } : {}),
    }),
  ],
  edges: [
    { from: 'start', to: 'open', label: 'case.opened' },
    {
      from: 'open',
      to: 'working',
      label: 'coordinator.accepted',
      condition: 'coordinator on shift',
    },
    { from: 'working', to: 'closed', label: 'outcome.recorded' },
    { kind: 'back', from: 'working', to: 'open', label: 'needs.more_info' },
  ],
});

export const caseLifecycle = lifecycle('case-lifecycle', 'state-machine', 'Follow-up case', {});
export const taskLifecycle = lifecycle(
  'task-lifecycle',
  'state-machine-fhir-task',
  'Follow-up task (FHIR Task)',
  {
    open: 'requested',
    working: 'in-progress',
    closed: 'completed',
  },
);
export const encounterLifecycle = lifecycle(
  'encounter-lifecycle',
  'state-machine-fhir-encounter',
  'Follow-up visit (FHIR Encounter)',
  { open: 'planned', working: 'in-progress', closed: 'finished' },
);

export const hopContext: WorkflowWriteV2 = {
  ...head(
    'hop-context',
    'flow',
    'HOP in context',
    'Who uses HOP, the systems it reads and writes, and over what.',
    'system-context',
  ),
  lanes: [lane('hospital', 'Hospital'), lane('hop', 'HOP'), lane('outside', 'Outside channels')],
  steps: [
    step('coordinator', 'A care coordinator works follow-ups.', [], {
      type: 'PERSON',
      band: 'hop',
      label: 'Care coordinator',
    }),
    step('hop-app', 'The HOP web app and its API.', ['coordinator'], {
      type: 'CONTAINER',
      band: 'hop',
      label: 'HOP app',
      purpose: 'Next.js web app over a Postgres-backed API.',
    }),
    step('his', 'The hospital information system.', ['hop-app'], {
      type: 'SYSTEM',
      band: 'hospital',
      label: 'Hospital HIS',
      owner: 'hospital IT',
    }),
    step('zalo', 'The Zalo messaging platform.', ['hop-app'], {
      type: 'SYSTEM',
      band: 'outside',
      label: 'Zalo',
      owner: 'Zalo (VNG)',
    }),
  ],
  edges: [
    { from: 'coordinator', to: 'hop-app', label: 'works follow-ups', protocol: 'HTTPS' },
    {
      kind: 'reads-from',
      from: 'hop-app',
      to: 'his',
      label: 'discharges and episodes',
      protocol: 'HL7v2 ADT',
    },
    {
      kind: 'writes-to',
      from: 'hop-app',
      to: 'zalo',
      label: 'patient reminders',
      protocol: 'Zalo OA API',
    },
  ],
};

export const dischargeFeed: WorkflowWriteV2 = {
  ...head(
    'his-discharge-feed',
    'flow',
    'Discharge feed',
    'The HIS tells HOP of a discharge, and HOP acknowledges it.',
    'integration-sequence',
  ),
  steps: [
    step('his', 'The HIS sends discharges.', [], {
      type: 'PARTICIPANT',
      label: 'Hospital HIS',
      refs: [ref('system-context', 'hop-context', 'his')],
    }),
    step('hop', 'HOP receives them.', [], {
      type: 'PARTICIPANT',
      label: 'HOP app',
      refs: [ref('system-context', 'hop-context', 'hop-app')],
    }),
    step('adt', 'An ADT^A03 discharge message.', ['his'], {
      type: 'MESSAGE',
      label: 'ADT^A03 discharge',
      payload: ['patient.id', 'episode.id'],
    }),
    step('ack', 'HOP acknowledges it.', ['adt', 'hop'], {
      type: 'MESSAGE',
      label: 'ACK',
      payload: ['message.id'],
    }),
  ],
  edges: [
    {
      kind: 'async',
      from: 'his',
      to: 'adt',
      label: 'sends',
      onFailure: 'the HIS resends from its queue',
    },
    { kind: 'reply', from: 'adt', to: 'ack', label: 'acknowledged' },
    { kind: 'reply', from: 'hop', to: 'ack', label: 'HOP answers' },
  ],
};

export const dischargeData: WorkflowWriteV2 = {
  ...head(
    'discharge-data',
    'flow',
    'Discharge data',
    'Where discharge data comes from, where it rests and what leaves.',
    'data-flow',
  ),
  lanes: [lane('hospital', 'Hospital'), lane('hop', 'HOP'), lane('outside', 'Outside channels')],
  steps: [
    step('his', 'Discharges are first recorded in the HIS.', [], {
      type: 'SOURCE_SYSTEM',
      band: 'hospital',
      label: 'Hospital HIS',
      refs: [ref('system-context', 'hop-context', 'his')],
    }),
    step('ingest', 'The feed is read into HOP.', ['his'], {
      type: 'PROCESS',
      band: 'hop',
      label: 'Ingest discharges',
    }),
    step('episodes', 'Episodes with their risk.', ['ingest'], {
      type: 'DATASET',
      band: 'hop',
      label: 'Episodes',
      owner: 'HOP clinical lead',
    }),
    step('remind', 'Reminders are built from episodes.', ['episodes'], {
      type: 'PROCESS',
      band: 'hop',
      label: 'Build reminders',
    }),
    step('zalo', 'Zalo delivers the reminder.', ['remind'], {
      type: 'EXTERNAL_ENTITY',
      band: 'outside',
      label: 'Zalo',
    }),
  ],
  edges: [
    { from: 'his', to: 'ingest', label: 'ADT discharges, live' },
    { from: 'ingest', to: 'episodes', label: 'episode rows' },
    { from: 'episodes', to: 'remind', label: 'due follow-ups, hourly' },
    { from: 'remind', to: 'zalo', label: 'name and slot only' },
  ],
};

export const followupDecision: WorkflowWriteV2 = {
  ...head(
    'followup-decision',
    'flow',
    'Follow-up decision',
    'Whether a discharge needs follow-up, and how soon.',
    'decision-model',
  ),
  steps: [
    step('risk', 'The episode risk.', [], {
      type: 'INPUT_DATA',
      label: 'Episode risk',
      refs: [ref('operational-flow', 'post-discharge', 'context')],
    }),
    step('policy', 'The hospital follow-up policy.', [], {
      type: 'KNOWLEDGE_SOURCE',
      label: 'Follow-up policy',
      owner: 'clinical lead',
    }),
    step('followup', 'Follow-up is decided from the risk.', ['risk', 'policy'], {
      type: 'DECISION',
      label: 'Follow-up needed',
      inputs: ['episode.risk'],
      conditions: [
        { when: 'episode.risk == high', result: 'within 48h' },
        { when: 'episode.risk == medium', result: 'within 7 days' },
        { when: 'episode.risk == low', result: 'none' },
      ],
      outputs: ['followup'],
    }),
  ],
};
