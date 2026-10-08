// operational-flow: what the business does when an event happens, HOP's template.

import {
  type TemplateEdgeKind,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
  type WorkflowTemplate,
} from './workflow-template-schema.js';

const T = WORKFLOW_TEMPLATE_SCHEMA_ID;

const contract = ['label', 'payload', 'onFailure'] as const;

const forward = (
  id: string,
  label: string,
  tooltip: string,
  ends: Pick<TemplateEdgeKind, 'fromTypes' | 'toTypes'>,
  look: Pick<TemplateEdgeKind, 'line' | 'colour'> = { line: 'solid', colour: 'neutral' },
): TemplateEdgeKind => ({
  id,
  label,
  tooltip,
  direction: 'forward',
  required: [...contract],
  ...ends,
  ...look,
});

export const operationalFlow: WorkflowTemplate = {
  $schema: T,
  id: 'operational-flow',
  version: 1,
  title: 'Operational flow',
  purpose:
    'Use when you are drawing what the business does when an event happens: the source that emits it, the context read about it, the rules that decide, the case and tasks people work, what they do, the outcome, and the feedback that closes the loop. HOP-style post-care work is drawn in it. In Event Storming terms an EVENT is a domain event, a RULE a policy, a TASK or ACTION a command and a STATE a read model.',
  layout: { family: 'layered-bands', direction: 'down' },
  lanes: {
    from: 'template',
    bands: [
      {
        id: 'trigger',
        label: 'Trigger',
        tooltip: 'What happened, and the source system that says so.',
        types: ['SOURCE', 'EVENT'],
      },
      {
        id: 'understand',
        label: 'Understand',
        tooltip: 'What is known about it: the records and context read.',
        types: ['ENTITY', 'CONTEXT'],
      },
      {
        id: 'decide',
        label: 'Decide',
        tooltip: 'The rules that decide, the state they set and what is expected next.',
        types: ['RULE', 'STATE', 'EXPECTATION'],
      },
      {
        id: 'organise',
        label: 'Organise work',
        tooltip: 'The case opened, the tasks assigned and what needs attention.',
        types: ['CASE', 'TASK', 'ATTENTION'],
      },
      {
        id: 'act',
        label: 'Act',
        tooltip: 'What people actually did.',
        types: ['ACTION'],
      },
      {
        id: 'result',
        label: 'Result',
        tooltip: 'The recorded outcome.',
        types: ['OUTCOME'],
      },
      {
        id: 'feedback',
        label: 'Feedback',
        tooltip: 'What the outcome changes: the context, rules and state it re-checks.',
        types: ['CONTEXT', 'RULE', 'STATE'],
      },
    ],
  },
  nodeTypes: [
    {
      id: 'SOURCE',
      label: 'Source',
      tooltip:
        'A system that holds the facts (a HIS, a LIS). It emits events and is read; nothing writes back into it.',
      icon: 'database',
      colour: 'slate',
      required: ['label', 'owner'],
      band: 'trigger',
      entry: true,
      lines: { out: [{ kind: 'emits', min: 1 }] },
    },
    {
      id: 'EVENT',
      label: 'Event',
      tooltip:
        'Something that happened, named domain.verb_past (`event`), with the keys it carries (`payload`). Exactly one source emits it.',
      icon: 'bolt',
      colour: 'orange',
      required: ['label', 'event', 'payload'],
      band: 'trigger',
      lines: { in: [{ kind: 'emits', min: 1, max: 1 }] },
      links: [
        {
          template: 'integration-sequence',
          types: ['MESSAGE'],
          required: false,
          tooltip: 'The sequence that carries this event from the outside system.',
        },
      ],
    },
    {
      id: 'ENTITY',
      label: 'Entity',
      tooltip: 'A record the flow reads: a customer, an episode.',
      icon: 'table',
      colour: 'indigo',
      required: ['label'],
      band: 'understand',
      entry: true,
      links: [
        {
          template: 'data-flow',
          types: ['DATASET'],
          required: false,
          tooltip: 'The dataset that holds this record, with its owner and classification.',
        },
      ],
    },
    {
      id: 'CONTEXT',
      label: 'Context',
      tooltip: 'Facts read about the event, from its records.',
      icon: 'database',
      colour: 'teal',
      required: ['label', 'inputs', 'outputs'],
      band: 'understand',
      entry: true,
      links: [
        {
          template: 'data-flow',
          types: ['DATASET'],
          required: false,
          tooltip: 'The dataset this context is read from.',
        },
      ],
    },
    {
      id: 'RULE',
      label: 'Rule',
      tooltip:
        'A decision: its inputs, the table of conditions, and the outputs it gives. Its full table lives in a decision-model design.',
      icon: 'diamond',
      colour: 'violet',
      required: ['label', 'inputs', 'conditions', 'outputs'],
      band: 'decide',
      links: [
        {
          template: 'decision-model',
          types: ['DECISION'],
          required: false,
          tooltip: 'The decision table this rule is.',
        },
      ],
    },
    {
      id: 'STATE',
      label: 'State',
      tooltip: 'A state the rule sets, as its state machine names it.',
      icon: 'circle-dot',
      colour: 'blue',
      required: ['label'],
      band: 'decide',
      links: [
        {
          template: 'state-machine',
          types: ['STATE', 'COMPOUND', 'FINAL'],
          required: false,
          tooltip: 'The state of the subject’s state machine this is.',
        },
      ],
    },
    {
      id: 'EXPECTATION',
      label: 'Expectation',
      tooltip: 'What must happen by when (`sla`); a miss breaches to an attention item.',
      icon: 'clock',
      colour: 'amber',
      required: ['label', 'sla'],
      band: 'decide',
      lines: { out: [{ kind: 'breaches', min: 1 }] },
    },
    {
      id: 'CASE',
      label: 'Case',
      tooltip: 'One unit of work with an owner.',
      icon: 'folder',
      colour: 'pink',
      required: ['label', 'owner'],
      band: 'organise',
    },
    {
      id: 'TASK',
      label: 'Task',
      tooltip: 'A piece of the case for one role, by a deadline, done once (`idempotency`).',
      icon: 'check-square',
      colour: 'pink',
      required: ['label', 'owner', 'sla', 'idempotency'],
      band: 'organise',
    },
    {
      id: 'ATTENTION',
      label: 'Attention',
      tooltip: 'Raised when an expectation is missed: late, unowned, unreachable.',
      icon: 'bell',
      colour: 'red',
      required: ['label'],
      band: 'organise',
    },
    {
      id: 'ACTION',
      label: 'Action',
      tooltip: 'What staff actually did: a call, a message, a booking. It ends in an outcome.',
      icon: 'arrow-right',
      colour: 'cyan',
      required: ['label', 'owner'],
      band: 'act',
      lines: { out: [{ kind: 'results-in', min: 1 }] },
    },
    {
      id: 'OUTCOME',
      label: 'Outcome',
      tooltip: 'The recorded result, one of a closed set (`values`). It feeds back.',
      icon: 'check-circle',
      colour: 'emerald',
      required: ['label', 'values'],
      band: 'result',
      lines: { out: [{ kind: 'feeds-back', min: 1 }] },
    },
  ],
  edgeKinds: [
    forward(
      'emits',
      'Emits',
      'A source system emits the event.',
      { fromTypes: ['SOURCE'], toTypes: ['EVENT'] },
      { line: 'solid', colour: 'slate' },
    ),
    forward(
      'enriches',
      'Enriches',
      'Context or a record informs the rule.',
      { fromTypes: ['ENTITY', 'CONTEXT'], toTypes: ['RULE'] },
      { line: 'dotted', colour: 'teal' },
    ),
    forward('evaluates', 'Evaluates', 'The event is put to a rule.', {
      fromTypes: ['EVENT'],
      toTypes: ['RULE'],
    }),
    forward('derives', 'Derives', 'The rule sets a state.', {
      fromTypes: ['RULE'],
      toTypes: ['STATE'],
    }),
    forward('expects', 'Expects', 'The state sets what is expected next.', {
      fromTypes: ['STATE'],
      toTypes: ['EXPECTATION'],
    }),
    forward('opens', 'Opens', 'A case is opened.', { toTypes: ['CASE'] }),
    forward('assigns', 'Assigns', 'The case assigns a task.', {
      fromTypes: ['CASE'],
      toTypes: ['TASK'],
    }),
    forward('performs', 'Performs', 'The task is done as an action.', {
      fromTypes: ['TASK'],
      toTypes: ['ACTION'],
    }),
    forward('results-in', 'Results in', 'The action ends in an outcome.', {
      fromTypes: ['ACTION'],
      toTypes: ['OUTCOME'],
    }),
    forward(
      'breaches',
      'Breaches',
      'A missed expectation raises attention.',
      { fromTypes: ['EXPECTATION'], toTypes: ['ATTENTION'] },
      { line: 'dashed', colour: 'amber' },
    ),
    {
      id: 'feeds-back',
      label: 'Feeds back',
      tooltip: 'The outcome returns to an earlier context or state and re-checks it.',
      direction: 'return',
      required: ['reevaluates', 'payload', 'idempotency', 'onFailure'],
      fromTypes: ['OUTCOME'],
      toTypes: ['CONTEXT', 'STATE', 'RULE'],
      line: 'dashed',
      colour: 'green',
    },
  ],
  defaultEdgeKind: 'evaluates',
  rules: ['acyclic', 'band-order'],
};
