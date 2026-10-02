// service-blueprint: what the patient goes through on both sides of the line of visibility, with
// its cross-functional preset, whose lanes are the roles a design names.

import {
  type TemplateEdgeKind,
  type TemplateNodeType,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
  type WorkflowTemplate,
} from './workflow-template-schema.js';

const T = WORKFLOW_TEMPLATE_SCHEMA_ID;

const blueprintTypes: TemplateNodeType[] = [
  {
    id: 'EVIDENCE',
    label: 'Evidence',
    tooltip: 'What the patient sees or holds: a letter, a message, a screen.',
    icon: 'eye',
    colour: 'neutral',
    required: ['label'],
    band: 'evidence',
  },
  {
    id: 'CUSTOMER_ACTION',
    label: 'Patient action',
    tooltip: 'What the patient or caregiver does.',
    icon: 'user',
    colour: 'orange',
    required: ['label', 'persona'],
    band: 'customer',
  },
  {
    id: 'FRONTSTAGE',
    label: 'Frontstage',
    tooltip: 'What staff or the product do in front of the patient, on a channel (`channel`).',
    icon: 'monitor',
    colour: 'blue',
    required: ['label', 'owner', 'channel'],
    band: 'frontstage',
    links: [
      {
        template: 'ux-flow',
        types: ['SCREEN'],
        required: false,
        tooltip: 'The screen a digital frontstage is.',
      },
    ],
  },
  {
    id: 'BACKSTAGE',
    label: 'Backstage',
    tooltip: 'What staff do out of the patient’s sight.',
    icon: 'folder',
    colour: 'pink',
    required: ['label', 'owner'],
    band: 'backstage',
    links: [
      {
        template: 'operational-flow',
        types: ['CASE', 'TASK', 'RULE'],
        required: false,
        tooltip: 'The step of the operational flow that does this work.',
      },
    ],
  },
  {
    id: 'SUPPORT',
    label: 'Support',
    tooltip: 'A system or service the work leans on.',
    icon: 'server',
    colour: 'slate',
    required: ['label'],
    band: 'support',
    links: [
      {
        template: 'system-context',
        types: ['SYSTEM', 'CONTAINER'],
        required: false,
        tooltip: 'The system this support is.',
      },
    ],
  },
  {
    id: 'GATEWAY',
    label: 'Gateway',
    tooltip: 'A branch: exclusive (one way, by condition) or parallel.',
    icon: 'git-branch',
    colour: 'violet',
    required: ['label', 'conditions'],
    band: 'backstage',
  },
  {
    id: 'WAIT',
    label: 'Wait',
    tooltip: 'Waiting on a timer or a message (`trigger`).',
    icon: 'clock',
    colour: 'amber',
    required: ['label', 'trigger'],
    band: 'backstage',
  },
  {
    id: 'FAIL_POINT',
    label: 'Fail point',
    tooltip: 'Where the experience often breaks.',
    icon: 'alert-triangle',
    colour: 'red',
    required: ['label'],
    band: 'backstage',
  },
];

const ACTING = ['CUSTOMER_ACTION', 'FRONTSTAGE', 'BACKSTAGE', 'GATEWAY', 'WAIT', 'FAIL_POINT'];

const blueprintKinds: TemplateEdgeKind[] = [
  {
    id: 'flow',
    label: 'Flow',
    tooltip: 'The next step. A patient action reaches a system only through the frontstage.',
    direction: 'forward',
    required: [],
    toTypes: ACTING,
    line: 'solid',
    colour: 'neutral',
  },
  {
    id: 'handoff',
    label: 'Handoff',
    tooltip: 'Work passes to another role; the line says who takes it.',
    direction: 'forward',
    required: ['label'],
    fromTypes: ['FRONTSTAGE', 'BACKSTAGE'],
    toTypes: ['FRONTSTAGE', 'BACKSTAGE'],
    line: 'dashed',
    colour: 'pink',
  },
  {
    id: 'uses',
    label: 'Uses',
    tooltip: 'Frontstage or backstage work leans on a support system.',
    direction: 'forward',
    required: [],
    fromTypes: ['FRONTSTAGE', 'BACKSTAGE'],
    toTypes: ['SUPPORT'],
    line: 'dotted',
    colour: 'slate',
  },
  {
    id: 'evidences',
    label: 'Evidences',
    tooltip: 'What the patient sees of a step.',
    direction: 'forward',
    required: [],
    toTypes: ['EVIDENCE'],
    line: 'dotted',
    colour: 'neutral',
  },
];

export const serviceBlueprint: WorkflowTemplate = {
  $schema: T,
  id: 'service-blueprint',
  version: 1,
  title: 'Service blueprint',
  purpose:
    'Use when you are drawing what a patient or customer goes through and what staff and systems do for it, on both sides of the line of visibility: evidence, patient actions, frontstage, backstage and support. Patient and journey maps are drawn in it. For a process where the lanes are roles you name, use its cross-functional preset.',
  layout: { family: 'lane-grid', direction: 'right' },
  lanes: {
    from: 'template',
    bands: [
      {
        id: 'evidence',
        label: 'Evidence',
        tooltip: 'What the patient sees or holds.',
        types: ['EVIDENCE'],
      },
      {
        id: 'customer',
        label: 'Patient',
        tooltip: 'What the patient or caregiver does. Line of interaction below.',
        types: ['CUSTOMER_ACTION'],
      },
      {
        id: 'frontstage',
        label: 'Frontstage',
        tooltip: 'What is done in front of them. Line of visibility below.',
        types: ['FRONTSTAGE', 'GATEWAY', 'WAIT', 'FAIL_POINT'],
      },
      {
        id: 'backstage',
        label: 'Backstage',
        tooltip: 'What is done out of sight. Line of internal interaction below.',
        types: ['BACKSTAGE', 'GATEWAY', 'WAIT', 'FAIL_POINT'],
      },
      {
        id: 'support',
        label: 'Support',
        tooltip: 'The systems and services it leans on.',
        types: ['SUPPORT', 'FAIL_POINT'],
      },
    ],
  },
  nodeTypes: blueprintTypes,
  edgeKinds: blueprintKinds,
  defaultEdgeKind: 'flow',
  rules: ['acyclic', 'personas-declared'],
};

function withoutBand(n: TemplateNodeType): TemplateNodeType {
  const { band, ...rest } = n;
  void band;
  return rest;
}

export const serviceBlueprintCrossFunctional: WorkflowTemplate = {
  ...serviceBlueprint,
  id: 'service-blueprint-cross-functional',
  title: 'Cross-functional process',
  purpose:
    'Use when you are drawing a process across roles you name — a swimlane, a BPMN-lite or UML activity diagram: each lane is a role the design declares in `lanes`, with the blueprint’s steps, gateways and waits.',
  presetOf: 'service-blueprint',
  lanes: { from: 'design', noun: 'role' },
  nodeTypes: blueprintTypes.map(withoutBand),
};
