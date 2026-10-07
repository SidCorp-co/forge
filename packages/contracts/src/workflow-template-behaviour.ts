// ux-flow, what a person sees and does on screen, and state-machine, the states a case or task
// moves through, with its FHIR Task and Encounter presets.

import {
  type TemplateNodeType,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
  type WorkflowTemplate,
} from './workflow-template-schema.js';

const T = WORKFLOW_TEMPLATE_SCHEMA_ID;

export const uxFlow: WorkflowTemplate = {
  $schema: T,
  id: 'ux-flow',
  version: 1,
  title: 'UI/UX flow',
  purpose:
    "Use when you are drawing what a person sees and does on screen: where they come in, the screens (each with its wireframe), the states a screen falls into (empty, loading, error, success, partial), the actions they take and where each leads, the system's responses, and where they leave. User flows and wireflows are drawn in it; an action links to the business step it triggers.",
  layout: { family: 'layered', direction: 'right' },
  lanes: { from: 'none' },
  nodeTypes: [
    {
      id: 'ENTRY',
      label: 'Start',
      tooltip: 'Where the person comes in: a link, a notification, a menu.',
      icon: 'play',
      colour: 'green',
      required: ['label'],
      entry: true,
      count: { min: 1 },
      lines: { out: [{ min: 1 }] },
    },
    {
      id: 'SCREEN',
      label: 'Screen',
      tooltip:
        'A screen: who it is for (`persona`), its `route`, the `wireframe` drawn for it and the `actions` it offers. One that shows data has its empty, loading and error states.',
      icon: 'monitor',
      colour: 'blue',
      required: ['label', 'persona', 'route', 'wireframe', 'actions'],
      unique: ['route'],
      links: [
        {
          template: 'service-blueprint',
          types: ['FRONTSTAGE'],
          required: false,
          tooltip: 'The frontstage step of the blueprint this screen is.',
        },
      ],
    },
    {
      id: 'UI_STATE',
      label: 'UI state',
      tooltip: 'A state a screen falls into: empty, loading, error, success or partial.',
      icon: 'alert-triangle',
      colour: 'amber',
      required: ['variant'],
    },
    {
      id: 'USER_ACTION',
      label: 'User action',
      tooltip:
        'What the person does, and where it leads: no action is a dead end. It links to the business step it triggers.',
      icon: 'pointer',
      colour: 'green',
      required: ['label'],
      lines: { out: [{ min: 1 }] },
      links: [
        {
          template: 'operational-flow',
          types: ['EVENT', 'ACTION'],
          required: false,
          tooltip: 'The event this action raises, or the action it records.',
        },
        {
          template: 'service-blueprint',
          types: ['FRONTSTAGE'],
          required: false,
          tooltip: 'The frontstage step this action is.',
        },
      ],
    },
    {
      id: 'DECISION',
      label: 'Decision',
      tooltip: "A branch on the person's input or permission.",
      icon: 'diamond',
      colour: 'violet',
      required: ['label', 'conditions'],
    },
    {
      id: 'SYSTEM',
      label: 'System',
      tooltip: 'What the system does in response, and what it answers.',
      icon: 'cpu',
      colour: 'slate',
      required: ['label', 'purpose'],
    },
    {
      id: 'EXIT',
      label: 'End',
      tooltip: 'Where the flow ends for the person.',
      icon: 'log-out',
      colour: 'emerald',
      required: ['label'],
      count: { min: 1 },
    },
  ],
  edgeKinds: [
    {
      id: 'flow',
      label: 'Flow',
      tooltip: 'The person goes on: a screen offers an action, an action reaches the system.',
      direction: 'forward',
      required: [],
      line: 'solid',
      colour: 'neutral',
    },
    {
      id: 'navigates',
      label: 'Navigates',
      tooltip: 'The person moves to another screen, or out.',
      direction: 'forward',
      required: [],
      fromTypes: ['ENTRY', 'SCREEN', 'USER_ACTION', 'DECISION'],
      toTypes: ['SCREEN', 'EXIT'],
      line: 'solid',
      colour: 'blue',
    },
    {
      id: 'shows',
      label: 'Shows',
      tooltip: 'The screen falls into one of its states.',
      direction: 'forward',
      required: [],
      fromTypes: ['SCREEN'],
      toTypes: ['UI_STATE'],
      line: 'dashed',
      colour: 'amber',
    },
    {
      id: 'returns',
      label: 'Returns',
      tooltip: 'The system answers: a screen or a state.',
      direction: 'forward',
      required: [],
      fromTypes: ['SYSTEM'],
      toTypes: ['SCREEN', 'UI_STATE', 'EXIT'],
      line: 'solid',
      colour: 'slate',
    },
    {
      id: 'back',
      label: 'Back',
      tooltip: 'The person goes back to an earlier screen.',
      direction: 'return',
      required: [],
      toTypes: ['SCREEN'],
      line: 'dashed',
      colour: 'neutral',
    },
  ],
  defaultEdgeKind: 'flow',
  rules: ['acyclic', 'screen-states', 'personas-declared'],
};

const MOVES = ['INITIAL', 'STATE', 'COMPOUND', 'PARALLEL_REGION', 'CHOICE'];
const SETTLES = ['STATE', 'COMPOUND', 'PARALLEL_REGION', 'CHOICE', 'FINAL'];

const machineTypes: TemplateNodeType[] = [
  {
    id: 'INITIAL',
    label: 'Initial',
    tooltip: 'Where the machine starts; there is exactly one.',
    icon: 'play',
    colour: 'green',
    required: [],
    entry: true,
    count: { min: 1, max: 1 },
    lines: { out: [{ min: 1 }] },
  },
  {
    id: 'STATE',
    label: 'State',
    tooltip: 'A state the subject is in. Every state but a final one has a way out.',
    icon: 'circle-dot',
    colour: 'blue',
    required: ['label'],
    lines: { out: [{ min: 1 }] },
  },
  {
    id: 'COMPOUND',
    label: 'Compound state',
    tooltip: 'A state that holds states of its own.',
    icon: 'folder',
    colour: 'indigo',
    required: ['label'],
    lines: { out: [{ min: 1 }] },
  },
  {
    id: 'PARALLEL_REGION',
    label: 'Parallel region',
    tooltip: 'States that run at the same time.',
    icon: 'git-merge',
    colour: 'violet',
    required: ['label'],
  },
  {
    id: 'CHOICE',
    label: 'Choice',
    tooltip: 'A branch on a guard; each way out has its condition.',
    icon: 'diamond',
    colour: 'violet',
    required: ['conditions'],
    lines: { out: [{ min: 1 }] },
  },
  {
    id: 'FINAL',
    label: 'Final',
    tooltip: 'A state nothing moves on from.',
    icon: 'stop',
    colour: 'emerald',
    required: ['label'],
  },
];

export const stateMachine: WorkflowTemplate = {
  $schema: T,
  id: 'state-machine',
  version: 1,
  title: 'State machine',
  purpose:
    'Use when you are drawing the states one thing — a case, a task, an attention item — moves through, the event that moves it (the line’s label), its guard (`condition`) and who may move it. Statecharts are drawn in it; FHIR Task and Encounter have presets.',
  layout: { family: 'state-machine', direction: 'down' },
  lanes: { from: 'none' },
  nodeTypes: machineTypes,
  edgeKinds: [
    {
      id: 'transition',
      label: 'Transition',
      tooltip: 'An event moves it on: event [guard] / action.',
      direction: 'forward',
      required: ['label'],
      fromTypes: MOVES,
      toTypes: SETTLES,
      line: 'solid',
      colour: 'neutral',
    },
    {
      id: 'after',
      label: 'After',
      tooltip: 'A timer moves it on: an SLA ran out (`condition`).',
      direction: 'forward',
      required: ['label', 'condition'],
      fromTypes: MOVES,
      toTypes: SETTLES,
      line: 'dashed',
      colour: 'amber',
    },
    {
      id: 'back',
      label: 'Back',
      tooltip: 'An event moves it back to an earlier state (a reopen).',
      direction: 'return',
      required: ['label'],
      fromTypes: MOVES,
      line: 'dashed',
      colour: 'neutral',
    },
  ],
  defaultEdgeKind: 'transition',
  rules: ['acyclic'],
};

const FHIR_TASK_STATUS = [
  'draft',
  'requested',
  'received',
  'accepted',
  'rejected',
  'ready',
  'cancelled',
  'in-progress',
  'on-hold',
  'failed',
  'completed',
  'entered-in-error',
];

const FHIR_ENCOUNTER_STATUS = [
  'planned',
  'arrived',
  'triaged',
  'in-progress',
  'onleave',
  'finished',
  'cancelled',
  'entered-in-error',
  'unknown',
];

function fhirPreset(id: string, resource: string, vocabulary: string[]): WorkflowTemplate {
  return {
    ...stateMachine,
    id,
    title: `FHIR ${resource} lifecycle`,
    purpose: `Use when the states you draw are a FHIR R4 ${resource}'s: every state names the ${resource}.status code it is (\`mapsTo\`), one of ${vocabulary.join(', ')}.`,
    presetOf: 'state-machine',
    nodeTypes: machineTypes.map((n) =>
      SETTLES.includes(n.id) && n.id !== 'CHOICE'
        ? { ...n, required: [...n.required, 'mapsTo'], vocabulary }
        : n,
    ),
  };
}

export const stateMachineFhirTask = fhirPreset('state-machine-fhir-task', 'Task', FHIR_TASK_STATUS);
export const stateMachineFhirEncounter = fhirPreset(
  'state-machine-fhir-encounter',
  'Encounter',
  FHIR_ENCOUNTER_STATUS,
);
