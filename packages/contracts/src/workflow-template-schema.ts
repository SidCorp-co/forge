// The workflow-template-v1 meta-schema and the resolution of a project's templates; the built-ins
// are in workflow-template-builtins.ts, and workflow-templates.ts is the one entry both are read through.
//
// a workflow diagram is drawn in a TEMPLATE — a closed vocabulary of bands, node types and
// edge kinds with the fields each owes — so one project's journey, another's state machine and a
// third's integration sequence are each checked against their own shape, and the canvas renders
// any of them from the template alone. The built-in templates are kernel and versioned here; a
// project may declare its own (or extend a built-in) in its project document, checked by the same
// meta-schema. Core validates designs against it; the web reads it to draw them.

import { z } from 'zod';

export const WORKFLOW_TEMPLATE_SCHEMA_ID =
  'https://forge.sidcorp.co/schemas/workflow-template-v1.json';

const LAYOUT_FAMILIES = [
  'layered-bands',
  'lane-grid',
  'layered',
  'state-machine',
  'lifeline',
  'decision-model',
  'boundaries',
] as const;

const LAYOUT_DIRECTIONS = ['down', 'right'] as const;

/** The icon keys a node type may name; the web holds one glyph per key and nothing else. */
export const TEMPLATE_ICONS = [
  'bolt',
  'database',
  'user',
  'diamond',
  'flag',
  'target',
  'folder',
  'check-square',
  'bell',
  'arrow-right',
  'check-circle',
  'circle',
  'circle-dot',
  'monitor',
  'pointer',
  'cpu',
  'log-out',
  'alert-triangle',
  'git-merge',
  'stop',
  'git-branch',
  'server',
  'send',
  'inbox',
  'table',
  'filter',
  'eye',
  'refresh',
  'clock',
  'play',
] as const;

/** The colour tokens a node type or edge kind may name; each is one hue with a light and a dark value. */
const TEMPLATE_COLOURS = [
  'orange',
  'slate',
  'teal',
  'violet',
  'blue',
  'amber',
  'pink',
  'green',
  'red',
  'cyan',
  'emerald',
  'indigo',
  'neutral',
] as const;

/** Every node field a template may require; the workflow-v2 node schema carries exactly these. */
export const NODE_REQUIRABLE_FIELDS = [
  'label',
  'purpose',
  'inputs',
  'outputs',
  'owner',
  'sla',
  'conditions',
  'tests',
  'expectedOutcome',
  'permissions',
  'persona',
  'wireframe',
  'dataShown',
  'actions',
  'trigger',
  'validation',
  'variant',
  'event',
  'route',
  'payload',
  'idempotency',
  'values',
  'mapsTo',
  'channel',
] as const;
export type NodeRequirableField = (typeof NODE_REQUIRABLE_FIELDS)[number];

/** The same closed list for edges, held to the workflow-v2 edge schema. */
const EDGE_REQUIRABLE_FIELDS = [
  'label',
  'condition',
  'action',
  'mapping',
  'idempotency',
  'onFailure',
  'reevaluates',
  'payload',
  'protocol',
] as const;

/**
 * `forward`: a line `after` draws, from an earlier step to a later one. `return`: a line back from
 * a later step to one it comes after — never drawn in `after`, so it orders nothing and is outside
 * the cycle check, and it is the only kind that may name what it `reevaluates`.
 */
const EDGE_DIRECTIONS = ['forward', 'return'] as const;

const EDGE_LINES = ['solid', 'dashed', 'dotted'] as const;

/** The rules a template may switch on; the kernel implements each, and this is what each one holds. */
export const TEMPLATE_RULE_MEANING = {
  acyclic:
    'no loop in `after`; the kernel holds it for every workflow, and a template lists it so its shape says so',
  'single-entry': 'exactly one step comes after nothing',
  'band-order': 'a forward line never runs from a later band to an earlier one',
  tree: 'every step comes after at most one step',
  'screen-states':
    'every SCREEN that shows data (`dataShown`) has a `shows` line to a UI_STATE of each variant empty, loading and error',
  'personas-declared': "every node's `persona` is one the design declares in `personas`",
} as const;

export const TEMPLATE_RULES = Object.keys(TEMPLATE_RULE_MEANING) as [
  keyof typeof TEMPLATE_RULE_MEANING,
  ...(keyof typeof TEMPLATE_RULE_MEANING)[],
];
export type TemplateRule = (typeof TEMPLATE_RULES)[number];

export const TEMPLATE_LIMITS = {
  title: 120,
  purpose: 600,
  label: 60,
  tooltip: 300,
  bands: 16,
  nodeTypes: 32,
  edgeKinds: 12,
  noun: 40,
  templates: 20,
  links: 6,
  lineRules: 6,
  vocabulary: 40,
  lineCount: 20,
} as const;

export const TEMPLATE_ID = /^[a-z][a-z0-9-]{1,62}$/;
export const NODE_TYPE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
export const EDGE_KIND_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const BAND_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const label = () => z.string().min(1).max(TEMPLATE_LIMITS.label);
const tooltip = () => z.string().min(1).max(TEMPLATE_LIMITS.tooltip);
const nodeTypeId = () => z.string().regex(NODE_TYPE_ID);
const edgeKindId = () => z.string().regex(EDGE_KIND_ID);
const bandId = () => z.string().regex(BAND_ID);

export const templateRefSchema = z.strictObject({
  id: z.string().regex(TEMPLATE_ID),
  version: z.number().int().min(1),
});
export type TemplateRef = z.infer<typeof templateRefSchema>;

const templateBandSchema = z.strictObject({
  id: bandId(),
  label: label(),
  tooltip: tooltip(),
  /** The node types a step in this band may be. */
  types: z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes),
});

/**
 * Where a diagram's bands come from: the template's own ordered list, the design itself (a
 * swimlane's actors, a sequence's systems — they differ per design, so the design declares them in
 * `lanes`), or nowhere (a tree or a state machine is not banded).
 */
const templateLanesSchema = z.discriminatedUnion('from', [
  z.strictObject({
    from: z.literal('template'),
    bands: z.array(templateBandSchema).min(1).max(TEMPLATE_LIMITS.bands),
  }),
  z.strictObject({
    from: z.literal('design'),
    /** What one lane is, in the approver's words: "actor", "system". */
    noun: z.string().min(1).max(TEMPLATE_LIMITS.noun),
  }),
  z.strictObject({ from: z.literal('none') }),
]);

/** How many lines of one kind (any kind, when it names none) a node of the type has, in or out. */
const templateLineRuleSchema = z.strictObject({
  kind: edgeKindId().optional(),
  min: z.number().int().min(0).max(TEMPLATE_LIMITS.lineCount),
  max: z.number().int().min(1).max(TEMPLATE_LIMITS.lineCount).optional(),
});

/**
 * A cross-link a node of the type may carry in `node.refs`: to a step of another design of the
 * project drawn in `template` (or a preset of it), whose type is one of `types`. `required` makes
 * one such ref owed; every ref carried must resolve, or the write is refused by name.
 */
const templateLinkSchema = z.strictObject({
  template: z.string().regex(TEMPLATE_ID),
  types: z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes),
  required: z.boolean(),
  tooltip: tooltip(),
});

export const templateNodeTypeSchema = z.strictObject({
  id: nodeTypeId(),
  label: label(),
  tooltip: tooltip(),
  icon: z.enum(TEMPLATE_ICONS),
  colour: z.enum(TEMPLATE_COLOURS),
  required: z.array(z.enum(NODE_REQUIRABLE_FIELDS)).max(NODE_REQUIRABLE_FIELDS.length),
  /** The band a node of this type sits in when it names none; template-banded templates only. */
  band: bandId().optional(),
  /** A step that comes after nothing is one of the entry types, when the template declares any. */
  entry: z.boolean().optional(),
  /** How many steps of this type one design holds. */
  count: z
    .strictObject({
      min: z.number().int().min(0).max(TEMPLATE_LIMITS.lineCount).optional(),
      max: z.number().int().min(1).max(TEMPLATE_LIMITS.lineCount).optional(),
    })
    .optional(),
  lines: z
    .strictObject({
      in: z.array(templateLineRuleSchema).min(1).max(TEMPLATE_LIMITS.lineRules).optional(),
      out: z.array(templateLineRuleSchema).min(1).max(TEMPLATE_LIMITS.lineRules).optional(),
    })
    .optional(),
  /** Fields whose value no two steps of this type share (a screen's route). */
  unique: z.array(z.enum(NODE_REQUIRABLE_FIELDS)).min(1).max(4).optional(),
  /** The closed set `node.mapsTo` takes (a FHIR status code). */
  vocabulary: z
    .array(z.string().min(1).max(TEMPLATE_LIMITS.noun))
    .min(1)
    .max(TEMPLATE_LIMITS.vocabulary)
    .optional(),
  links: z.array(templateLinkSchema).min(1).max(TEMPLATE_LIMITS.links).optional(),
});
export type TemplateNodeType = z.infer<typeof templateNodeTypeSchema>;

export const templateEdgeKindSchema = z.strictObject({
  id: edgeKindId(),
  label: label(),
  tooltip: tooltip(),
  direction: z.enum(EDGE_DIRECTIONS),
  required: z.array(z.enum(EDGE_REQUIRABLE_FIELDS)).max(EDGE_REQUIRABLE_FIELDS.length),
  /** The node types a line of this kind may leave, and may reach; absent, any. */
  fromTypes: z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes).optional(),
  toTypes: z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes).optional(),
  line: z.enum(EDGE_LINES),
  colour: z.enum(TEMPLATE_COLOURS),
});
export type TemplateEdgeKind = z.infer<typeof templateEdgeKindSchema>;

const templateHead = {
  $schema: z.literal(WORKFLOW_TEMPLATE_SCHEMA_ID),
  id: z.string().regex(TEMPLATE_ID),
  /** This template's own version; a design names `{ id, version }`, and a changed template is a new version. */
  version: z.number().int().min(1),
  title: z.string().min(1).max(TEMPLATE_LIMITS.title),
  /** "Use when …": what an agent builder is drawing when this is the template to pick. */
  purpose: z.string().min(1).max(TEMPLATE_LIMITS.purpose),
  /** The template id this one is a preset of; a link to that id also reaches a design drawn in this. */
  presetOf: z.string().regex(TEMPLATE_ID).optional(),
};

export const workflowTemplateSchema = z.strictObject({
  ...templateHead,
  layout: z.strictObject({
    family: z.enum(LAYOUT_FAMILIES),
    direction: z.enum(LAYOUT_DIRECTIONS),
  }),
  lanes: templateLanesSchema,
  nodeTypes: z.array(templateNodeTypeSchema).min(1).max(TEMPLATE_LIMITS.nodeTypes),
  /** The type a step with no `node` is read as; absent, every step names its node. */
  defaultNodeType: nodeTypeId().optional(),
  edgeKinds: z.array(templateEdgeKindSchema).min(1).max(TEMPLATE_LIMITS.edgeKinds),
  /** The kind a line naming none takes when its endpoint types fit several kinds (`lineKindOf`). */
  defaultEdgeKind: edgeKindId(),
  rules: z.array(z.enum(TEMPLATE_RULES)).max(TEMPLATE_RULES.length),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

/**
 * A project's extension of a template: it adds, it never overrides. New node types and edge kinds
 * are appended; `bands` adds new bands after the base's, and `bandTypes` admits more types into a
 * base band. An id the base already holds is refused by name.
 */
export const workflowTemplateExtensionSchema = z.strictObject({
  ...templateHead,
  extends: templateRefSchema,
  nodeTypes: z.array(templateNodeTypeSchema).max(TEMPLATE_LIMITS.nodeTypes).optional(),
  edgeKinds: z.array(templateEdgeKindSchema).max(TEMPLATE_LIMITS.edgeKinds).optional(),
  bands: z.array(templateBandSchema).max(TEMPLATE_LIMITS.bands).optional(),
  bandTypes: z
    .record(bandId(), z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes))
    .optional(),
  rules: z.array(z.enum(TEMPLATE_RULES)).max(TEMPLATE_RULES.length).optional(),
});
export type WorkflowTemplateExtension = z.infer<typeof workflowTemplateExtensionSchema>;

/** What a project document's `workflows.templates` holds: complete templates and extensions. */
export const projectWorkflowTemplateSchema = z.union([
  workflowTemplateExtensionSchema,
  workflowTemplateSchema,
]);
export type ProjectWorkflowTemplate = z.infer<typeof projectWorkflowTemplateSchema>;

export const isTemplateExtension = (t: ProjectWorkflowTemplate): t is WorkflowTemplateExtension =>
  'extends' in t;

export const TEMPLATE_REFUSAL_CODES = [
  'WORKFLOW_TEMPLATE_UNKNOWN',
  'WORKFLOW_TEMPLATE_ID_TAKEN',
  'WORKFLOW_TEMPLATE_DUPLICATE',
  'WORKFLOW_TEMPLATE_INVALID',
  'WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES',
] as const;
export type TemplateRefusalCode = (typeof TEMPLATE_REFUSAL_CODES)[number];

export interface TemplateRefusal {
  code: TemplateRefusalCode;
  path: string;
  detail: string;
}
