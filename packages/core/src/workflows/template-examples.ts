/**
 * One small design per built-in template, served beside it (`GET /api/workflow-templates/:id/:version`)
 * so an agent builder copies a shape that is accepted rather than guessing one. They are one
 * project's designs and link to each other, so a ref shows resolving. `templates.test.ts` holds
 * each one to its template with the others as its project, so an example that stops passing
 * fails there by name.
 */

import type { WorkflowWriteV2 } from './schema.js';
import { EXAMPLE_BOARD, head, lane, ref, step } from './template-example-kit.js';
import {
  caseLifecycle,
  dischargeData,
  dischargeFeed,
  encounterLifecycle,
  followupDecision,
  hopContext,
  taskLifecycle,
} from './template-examples-systems.js';

const contract = (
  from: string,
  to: string,
  label: string,
  payload: string[],
  onFailure: string,
) => ({
  from,
  to,
  label,
  payload,
  onFailure,
});

const operational: WorkflowWriteV2 = {
  ...head(
    'post-discharge',
    'flow',
    'Post-discharge follow-up',
    'A high-risk discharge becomes one case with an owner, and the outcome re-checks the context.',
    'operational-flow',
  ),
  steps: [
    step('his', 'The hospital HIS records the discharge.', [], {
      type: 'SOURCE',
      label: 'Hospital HIS',
      owner: 'hospital IT',
    }),
    step('discharged', 'patient.discharged arrives from the HIS.', ['his'], {
      type: 'EVENT',
      label: 'Patient discharged',
      event: 'patient.discharged',
      payload: ['patient.id', 'episode.id'],
      refs: [ref('integration-sequence', 'his-discharge-feed', 'adt')],
    }),
    step('context', 'The episode risk and care team are read.', [], {
      type: 'CONTEXT',
      label: 'Know the patient',
      inputs: ['episode.id'],
      outputs: ['episode.risk', 'care_team'],
      refs: [ref('data-flow', 'discharge-data', 'episodes')],
    }),
    step(
      'followup-rule',
      'A high-risk discharge needs follow-up within 48 hours.',
      ['discharged', 'context'],
      {
        type: 'RULE',
        label: 'Decide follow-up',
        inputs: ['episode.risk'],
        conditions: [{ when: 'episode.risk == high', result: 'follow-up required' }],
        outputs: ['followup_required'],
        refs: [ref('decision-model', 'followup-decision', 'followup')],
      },
    ),
    step('case', 'One follow-up case is opened for the episode.', ['followup-rule'], {
      type: 'CASE',
      label: 'Open follow-up case',
      owner: 'care coordinator',
    }),
    step('call-task', 'The coordinator is asked to call within 48 hours.', ['case'], {
      type: 'TASK',
      label: 'Call the patient',
      owner: 'care coordinator',
      sla: '48h',
      idempotency: 'one call task per case',
    }),
    step('call', 'The coordinator calls the patient.', ['call-task'], {
      type: 'ACTION',
      label: 'Call made',
      owner: 'care coordinator',
    }),
    step('outcome', 'The call is recorded as reached, unreachable or declined.', ['call'], {
      type: 'OUTCOME',
      label: 'Record the result',
      values: ['reached', 'unreachable', 'declined'],
    }),
  ],
  edges: [
    contract(
      'his',
      'discharged',
      'ADT discharge',
      ['patient.id', 'episode.id'],
      'retry the feed, then raise to IT',
    ),
    contract(
      'discharged',
      'followup-rule',
      'Is follow-up needed?',
      ['episode.id'],
      'hold the event for re-run',
    ),
    contract(
      'context',
      'followup-rule',
      'Risk and care team',
      ['episode.risk'],
      'decide without risk: follow up',
    ),
    {
      ...contract(
        'followup-rule',
        'case',
        'Follow-up required',
        ['patient.id', 'episode.id'],
        'create_attention_item',
      ),
      condition: 'followup_required == true',
      action: 'create_or_update_case',
      mapping: { patient_id: 'patient.id', episode_id: 'episode.id' },
      idempotency: 'one active case per discharge episode',
    },
    contract(
      'case',
      'call-task',
      'Assign the call',
      ['case.id'],
      'leave the case unassigned and flag it',
    ),
    contract(
      'call-task',
      'call',
      'Coordinator calls',
      ['case.id', 'patient.phone'],
      'retry next working day',
    ),
    contract('call', 'outcome', 'Call result', ['call.result'], 'record unreachable'),
    {
      kind: 'feeds-back',
      from: 'outcome',
      to: 'context',
      reevaluates: 'the patient context the rule reads',
      payload: ['call.outcome'],
      idempotency: 'one re-evaluation per outcome',
      onFailure: 'create_attention_item',
    },
  ],
};

const screen = (label: string, route: string, actions: string[], dataShown?: string[]) => ({
  type: 'SCREEN',
  label,
  persona: 'patient',
  route,
  wireframe: { attachment: EXAMPLE_BOARD },
  actions,
  ...(dataShown ? { dataShown } : {}),
});

const ux: WorkflowWriteV2 = {
  ...head(
    'book-followup',
    'flow',
    'Book a follow-up',
    'From the reminder link the patient picks a slot and books it.',
    'ux-flow',
  ),
  personas: [lane('patient', 'Patient')],
  steps: [
    step('link', 'The patient opens the reminder link.', [], {
      type: 'ENTRY',
      label: 'Reminder link',
    }),
    step(
      'slots',
      'The open slots for the clinic are listed.',
      ['link'],
      screen('Pick a time', '/book', ['pick a slot'], ['open slots']),
    ),
    step('slots-loading', 'The slots are still loading.', ['slots'], {
      type: 'UI_STATE',
      variant: 'loading',
    }),
    step('slots-empty', 'No slot is open this week.', ['slots'], {
      type: 'UI_STATE',
      variant: 'empty',
    }),
    step('slots-error', 'The slots could not be read.', ['slots'], {
      type: 'UI_STATE',
      variant: 'error',
    }),
    step('pick', 'The patient picks a slot and confirms.', ['slots'], {
      type: 'USER_ACTION',
      label: 'Book this slot',
      refs: [
        ref('operational-flow', 'post-discharge', 'call'),
        ref('service-blueprint', 'followup-blueprint', 'confirm'),
      ],
    }),
    step('book', 'The booking is saved against the case.', ['pick'], {
      type: 'SYSTEM',
      label: 'Save booking',
      purpose: 'Holds the slot and records it on the follow-up case.',
    }),
    step(
      'booked',
      'The patient sees the booking.',
      ['book'],
      screen('Booked', '/book/done', ['close']),
    ),
    step('done', 'The patient closes the page.', ['booked'], { type: 'EXIT', label: 'Done' }),
  ],
};

const blueprint: WorkflowWriteV2 = {
  ...head(
    'followup-blueprint',
    'flow',
    'Follow-up booking',
    'The reminder the patient gets, what they do, and the work behind it.',
    'service-blueprint',
  ),
  personas: [lane('patient', 'Patient')],
  steps: [
    step('reminder', 'A Zalo reminder is sent.', [], {
      type: 'FRONTSTAGE',
      label: 'Zalo reminder',
      owner: 'HOP',
      channel: 'Zalo',
    }),
    step('message', 'The patient reads the reminder.', ['reminder'], {
      type: 'EVIDENCE',
      label: 'Reminder message',
    }),
    step('books', 'The patient books a slot.', ['message'], {
      type: 'CUSTOMER_ACTION',
      label: 'Books a slot',
      persona: 'patient',
    }),
    step('confirm', 'The booking is confirmed on screen.', ['books'], {
      type: 'FRONTSTAGE',
      label: 'Booking confirmed',
      owner: 'HOP',
      channel: 'web',
      refs: [ref('ux-flow', 'book-followup', 'booked')],
    }),
    step('schedule', 'The coordinator schedules the call.', ['confirm'], {
      type: 'BACKSTAGE',
      label: 'Schedule the call',
      owner: 'care coordinator',
      refs: [ref('operational-flow', 'post-discharge', 'call-task')],
    }),
    step('his-sync', 'The booking is written to the HIS.', ['schedule'], {
      type: 'SUPPORT',
      label: 'HIS appointment',
      refs: [ref('system-context', 'hop-context', 'his')],
    }),
  ],
};

const crossFunctional: WorkflowWriteV2 = {
  ...head(
    'referral-handoff',
    'flow',
    'Referral handoff',
    'The coordinator takes a referral and hands the review to a nurse.',
    'service-blueprint-cross-functional',
  ),
  lanes: [lane('coordinator', 'Coordinator'), lane('nurse', 'Nurse')],
  steps: [
    step('take', 'The coordinator takes the referral.', [], {
      type: 'FRONTSTAGE',
      band: 'coordinator',
      label: 'Take referral',
      owner: 'coordinator',
      channel: 'phone',
    }),
    step('review', 'A nurse reviews it.', ['take'], {
      type: 'BACKSTAGE',
      band: 'nurse',
      label: 'Review referral',
      owner: 'nurse',
    }),
  ],
  edges: [{ kind: 'handoff', from: 'take', to: 'review', label: 'to the nurse on shift' }],
};

export const TEMPLATE_EXAMPLES: Readonly<Record<string, WorkflowWriteV2>> = {
  'operational-flow@1': operational,
  'service-blueprint@1': blueprint,
  'service-blueprint-cross-functional@1': crossFunctional,
  'ux-flow@1': ux,
  'state-machine@1': caseLifecycle,
  'state-machine-fhir-task@1': taskLifecycle,
  'state-machine-fhir-encounter@1': encounterLifecycle,
  'integration-sequence@1': dischargeFeed,
  'decision-model@1': followupDecision,
  'data-flow@1': dischargeData,
  'system-context@1': hopContext,
};
