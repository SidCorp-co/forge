// The workflow-template-v1 meta-schema and the resolution of a project's templates; the built-ins
// are in workflow-template-builtins.ts, and workflow-templates.ts is the one entry both are read through.
//
// cm:why a workflow diagram is drawn in a TEMPLATE — a closed vocabulary of bands, node types and
// edge kinds with the fields each owes — so one project's journey, another's state machine and a
// third's integration sequence are each checked against their own shape, and the canvas renders
// any of them from the template alone. The built-in templates are kernel and versioned here; a
// project may declare its own (or extend a built-in) in its project document, checked by the same
// meta-schema. Core validates designs against it; the web reads it to draw them.

import { z } from 'zod';

export const WORKFLOW_TEMPLATE_SCHEMA_ID =
  'https://forge.sidcorp.co/schemas/workflow-template-v1.json';

export const LAYOUT_FAMILIES = [
  'layered-bands',
  'state-machine',
  'sequence',
  'swimlane-actors',
  'decision-tree',
  'lineage',
] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

export const LAYOUT_DIRECTIONS = ['down', 'right'] as const;

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
export const TEMPLATE_COLOURS = [
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
  'invokes',
  'variant',
] as const;
export type NodeRequirableField = (typeof NODE_REQUIRABLE_FIELDS)[number];

/** The same closed list for edges, held to the workflow-v2 edge schema. */
export const EDGE_REQUIRABLE_FIELDS = [
  'label',
  'condition',
  'action',
  'mapping',
  'idempotency',
  'onFailure',
  'reevaluates',
  'payload',
  'success',
  'failure',
] as const;
export type EdgeRequirableField = (typeof EDGE_REQUIRABLE_FIELDS)[number];

/**
 * `forward`: a line `after` draws, from an earlier step to a later one. `return`: a line back from
 * a later step to one it comes after — never drawn in `after`, so it orders nothing and is outside
 * the cycle check, and it is the only kind that may name what it `reevaluates`.
 */
export const EDGE_DIRECTIONS = ['forward', 'return'] as const;
export type EdgeDirection = (typeof EDGE_DIRECTIONS)[number];

export const EDGE_LINES = ['solid', 'dashed', 'dotted'] as const;

/** The rules a template may switch on; the kernel implements each, and this is what each one holds. */
export const TEMPLATE_RULE_MEANING = {
  acyclic:
    'no loop in `after`; the kernel holds it for every workflow, and a template lists it so its shape says so',
  'single-entry': 'exactly one step comes after nothing',
  'single-initial': 'exactly one node is `initial: true`',
  'terminal-declared':
    'at least one node is `terminal: true`, and no step comes after a terminal one',
  'band-order': 'a forward line never runs from a later band to an earlier one',
  tree: 'every step comes after at most one step',
  'screen-error-state':
    'every SCREEN has an `error` edge to a UI_STATE of variant `error`, or says why not in `noErrorState`',
  'submit-targets': "every `submit` edge's `success` and `failure` name steps of the design",
  'invokes-resolve': 'every `invokes` names a step of another design of the same project',
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

export const templateBandSchema = z.strictObject({
  id: bandId(),
  label: label(),
  tooltip: tooltip(),
  /** The node types a step in this band may be. */
  types: z.array(nodeTypeId()).min(1).max(TEMPLATE_LIMITS.nodeTypes),
});
export type TemplateBand = z.infer<typeof templateBandSchema>;

/**
 * Where a diagram's bands come from: the template's own ordered list, the design itself (a
 * swimlane's actors, a sequence's systems — they differ per design, so the design declares them in
 * `lanes`), or nowhere (a tree or a state machine is not banded).
 */
export const templateLanesSchema = z.discriminatedUnion('from', [
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
export type TemplateLanes = z.infer<typeof templateLanesSchema>;

export const templateNodeTypeSchema = z.strictObject({
  id: nodeTypeId(),
  label: label(),
  tooltip: tooltip(),
  icon: z.enum(TEMPLATE_ICONS),
  colour: z.enum(TEMPLATE_COLOURS),
  required: z.array(z.enum(NODE_REQUIRABLE_FIELDS)).max(NODE_REQUIRABLE_FIELDS.length),
  /** The band a node of this type sits in when it names none; template-banded templates only. */
  band: bandId().optional(),
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
  /** The kind of an edge that names none, and of every `after` line no edge entry carries. */
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

const at = (base: string, ...rest: (string | number)[]) =>
  [base, ...rest.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');

const refKey = (r: TemplateRef) => `${r.id}@${r.version}`;

function duplicates(ids: readonly string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/** A complete template held to its own consistency: every id it names, it declares. */
export function templateConsistencyRefusals(t: WorkflowTemplate, base = ''): TemplateRefusal[] {
  const out: TemplateRefusal[] = [];
  const bad = (path: string, detail: string) =>
    out.push({
      code: 'WORKFLOW_TEMPLATE_INVALID',
      path,
      detail: `template ${t.id}@${t.version}: ${detail}`,
    });
  const types = new Set(t.nodeTypes.map((n) => n.id));
  for (const d of duplicates(t.nodeTypes.map((n) => n.id)))
    bad(
      at(base, 'nodeTypes'),
      `node type ${d} is declared twice; a type id is unique in its template.`,
    );
  for (const d of duplicates(t.edgeKinds.map((k) => k.id)))
    bad(
      at(base, 'edgeKinds'),
      `edge kind ${d} is declared twice; a kind id is unique in its template.`,
    );
  if (!t.edgeKinds.some((k) => k.id === t.defaultEdgeKind))
    bad(
      at(base, 'defaultEdgeKind'),
      `defaultEdgeKind "${t.defaultEdgeKind}" is none of its edge kinds (${t.edgeKinds.map((k) => k.id).join(', ')}).`,
    );
  if (t.defaultNodeType !== undefined && !types.has(t.defaultNodeType))
    bad(
      at(base, 'defaultNodeType'),
      `defaultNodeType "${t.defaultNodeType}" is none of its node types.`,
    );
  const def = t.edgeKinds.find((k) => k.id === t.defaultEdgeKind);
  if (def && def.direction !== 'forward')
    bad(
      at(base, 'defaultEdgeKind'),
      `defaultEdgeKind "${def.id}" is a ${def.direction} kind; an \`after\` line is forward, so the default kind is too.`,
    );
  for (const [i, k] of t.edgeKinds.entries()) {
    for (const side of ['fromTypes', 'toTypes'] as const) {
      (k[side] ?? []).forEach((ty, j) => {
        if (!types.has(ty))
          bad(
            at(base, 'edgeKinds', i, side, j),
            `edge kind "${k.id}" names ${ty} in ${side}, which is none of its node types.`,
          );
      });
    }
    if (k.direction === 'forward' && k.required.includes('reevaluates'))
      bad(
        at(base, 'edgeKinds', i, 'required'),
        `forward kind "${k.id}" requires \`reevaluates\`; only a return kind re-evaluates an earlier step.`,
      );
  }
  const bands = t.lanes.from === 'template' ? t.lanes.bands : [];
  for (const d of duplicates(bands.map((b) => b.id)))
    bad(at(base, 'lanes', 'bands'), `band ${d} is declared twice.`);
  bands.forEach((b, i) => {
    b.types.forEach((ty, j) => {
      if (!types.has(ty))
        bad(
          at(base, 'lanes', 'bands', i, 'types', j),
          `band "${b.id}" admits ${ty}, which is none of its node types.`,
        );
    });
  });
  const byBand = new Map(bands.map((b) => [b.id, b]));
  t.nodeTypes.forEach((n, i) => {
    if (n.band === undefined) {
      if (t.lanes.from === 'template' && !bands.some((b) => b.types.includes(n.id)))
        bad(
          at(base, 'nodeTypes', i),
          `node type ${n.id} is admitted by no band, so no step of it could be placed.`,
        );
      return;
    }
    if (t.lanes.from !== 'template') {
      bad(
        at(base, 'nodeTypes', i, 'band'),
        `node type ${n.id} names home band "${n.band}", but this template's lanes come from ${t.lanes.from === 'design' ? 'the design' : 'nowhere'}; only a template-banded template has home bands.`,
      );
      return;
    }
    const home = byBand.get(n.band);
    if (!home)
      bad(
        at(base, 'nodeTypes', i, 'band'),
        `node type ${n.id} names home band "${n.band}", which is none of its bands (${bands.map((b) => b.id).join(', ')}).`,
      );
    else if (!home.types.includes(n.id))
      bad(
        at(base, 'nodeTypes', i, 'band'),
        `node type ${n.id}'s home band "${n.band}" does not admit ${n.id}; add it to that band's types.`,
      );
  });
  const kindIds = new Set(t.edgeKinds.map((k) => k.id));
  const needs: [TemplateRule, string[], string[]][] = [
    ['screen-error-state', ['SCREEN', 'UI_STATE'], ['error']],
    ['submit-targets', [], ['submit']],
    ['invokes-resolve', ['SYSTEM_STEP'], []],
  ];
  for (const [rule, wantTypes, wantKinds] of needs) {
    if (!t.rules.includes(rule)) continue;
    const lacking = [
      ...wantTypes.filter((x) => !types.has(x)),
      ...wantKinds.filter((x) => !kindIds.has(x)),
    ];
    if (lacking.length > 0)
      bad(
        at(base, 'rules'),
        `rule ${rule} reads ${[...wantTypes, ...wantKinds].join(', ')}, and this template declares no ${lacking.join(', ')}.`,
      );
  }
  if (t.rules.includes('band-order') && t.lanes.from !== 'template')
    bad(
      at(base, 'rules'),
      "rule band-order orders the template's own bands, and this template declares none; a design's lanes are actors or systems, which have no order.",
    );
  return out;
}

/** An extension applied to its base; what it adds is appended, and an id it re-declares is refused. */
export function applyExtension(
  baseTemplate: WorkflowTemplate,
  ext: WorkflowTemplateExtension,
  base = '',
): { ok: true; value: WorkflowTemplate } | { ok: false; refusals: TemplateRefusal[] } {
  const out: TemplateRefusal[] = [];
  const over = (path: string, what: string) =>
    out.push({
      code: 'WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES',
      path,
      detail: `${ext.id}@${ext.version} extends ${refKey(ext.extends)} and re-declares its ${what}; an extension adds, it never overrides. Give it a new id, or write a complete template instead.`,
    });
  const typeIds = new Set(baseTemplate.nodeTypes.map((n) => n.id));
  (ext.nodeTypes ?? []).forEach((n, i) => {
    if (typeIds.has(n.id)) over(at(base, 'nodeTypes', i, 'id'), `node type ${n.id}`);
  });
  const kindIds = new Set(baseTemplate.edgeKinds.map((k) => k.id));
  (ext.edgeKinds ?? []).forEach((k, i) => {
    if (kindIds.has(k.id)) over(at(base, 'edgeKinds', i, 'id'), `edge kind ${k.id}`);
  });
  const lanes = baseTemplate.lanes;
  const baseBands = lanes.from === 'template' ? lanes.bands : [];
  if ((ext.bands?.length || Object.keys(ext.bandTypes ?? {}).length) && lanes.from !== 'template') {
    out.push({
      code: 'WORKFLOW_TEMPLATE_INVALID',
      path: at(base, ext.bands ? 'bands' : 'bandTypes'),
      detail: `${ext.id}@${ext.version} adds bands to ${refKey(ext.extends)}, whose lanes come from ${lanes.from === 'design' ? 'the design' : 'nowhere'}; only a template-banded template takes more bands.`,
    });
  }
  const bandIds = new Set(baseBands.map((b) => b.id));
  (ext.bands ?? []).forEach((b, i) => {
    if (bandIds.has(b.id))
      over(at(base, 'bands', i, 'id'), `band ${b.id} (admit more types into it with bandTypes)`);
  });
  for (const key of Object.keys(ext.bandTypes ?? {})) {
    if (!bandIds.has(key))
      out.push({
        code: 'WORKFLOW_TEMPLATE_INVALID',
        path: at(base, 'bandTypes', key),
        detail: `bandTypes names "${key}", which is no band of ${refKey(ext.extends)} (${[...bandIds].join(', ')}); a new band goes in \`bands\`.`,
      });
  }
  if (out.length > 0) return { ok: false, refusals: out };
  const merged: WorkflowTemplate = {
    ...baseTemplate,
    $schema: WORKFLOW_TEMPLATE_SCHEMA_ID,
    id: ext.id,
    version: ext.version,
    title: ext.title,
    purpose: ext.purpose,
    lanes:
      lanes.from === 'template'
        ? {
            from: 'template',
            bands: [
              ...lanes.bands.map((b) => ({
                ...b,
                types: [
                  ...b.types,
                  ...(ext.bandTypes?.[b.id] ?? []).filter((t) => !b.types.includes(t)),
                ],
              })),
              ...(ext.bands ?? []),
            ],
          }
        : lanes,
    nodeTypes: [...baseTemplate.nodeTypes, ...(ext.nodeTypes ?? [])],
    edgeKinds: [...baseTemplate.edgeKinds, ...(ext.edgeKinds ?? [])],
    rules: [...new Set([...baseTemplate.rules, ...(ext.rules ?? [])])],
  };
  const consistency = templateConsistencyRefusals(merged, base);
  return consistency.length > 0
    ? { ok: false, refusals: consistency }
    : { ok: true, value: merged };
}

export interface ResolvedTemplates {
  templates: WorkflowTemplate[];
  /** Which project templates are the project's own, by `id@version`. */
  projectKeys: Set<string>;
  refusals: TemplateRefusal[];
}

/**
 * The templates a project may draw in: the built-ins, then its own, each extension applied to its
 * base (a built-in, or a project template declared before it). A project template id that is a
 * built-in's, or an `id@version` declared twice, is refused by name.
 */
export function resolveProjectTemplates(
  declared: readonly ProjectWorkflowTemplate[],
  builtins: readonly WorkflowTemplate[],
  base = '/workflows/templates',
): ResolvedTemplates {
  const byKey = new Map(builtins.map((t) => [refKey(t), t]));
  const builtinIds = new Set(builtins.map((t) => t.id));
  const refusals: TemplateRefusal[] = [];
  const projectKeys = new Set<string>();
  const own: WorkflowTemplate[] = [];
  declared.forEach((t, i) => {
    const path = at(base, i);
    if (builtinIds.has(t.id)) {
      refusals.push({
        code: 'WORKFLOW_TEMPLATE_ID_TAKEN',
        path: at(path, 'id'),
        detail: `"${t.id}" is a built-in template's id; a project template takes its own id (extend the built-in with \`extends: { id: "${t.id}", version }\` under a new id).`,
      });
      return;
    }
    if (byKey.has(refKey(t))) {
      refusals.push({
        code: 'WORKFLOW_TEMPLATE_DUPLICATE',
        path: at(path, 'version'),
        detail: `${refKey(t)} is declared twice; a changed template is a new version.`,
      });
      return;
    }
    let resolved: WorkflowTemplate;
    if (isTemplateExtension(t)) {
      const parent = byKey.get(refKey(t.extends));
      if (!parent) {
        refusals.push({
          code: 'WORKFLOW_TEMPLATE_UNKNOWN',
          path: at(path, 'extends'),
          detail: `${t.id}@${t.version} extends ${refKey(t.extends)}, which is no built-in template and no project template declared before it (known: ${[...byKey.keys()].join(', ')}).`,
        });
        return;
      }
      const applied = applyExtension(parent, t, path);
      if (!applied.ok) {
        refusals.push(...applied.refusals);
        return;
      }
      resolved = applied.value;
    } else {
      const consistency = templateConsistencyRefusals(t, path);
      if (consistency.length > 0) {
        refusals.push(...consistency);
        return;
      }
      resolved = t;
    }
    byKey.set(refKey(resolved), resolved);
    projectKeys.add(refKey(resolved));
    own.push(resolved);
  });
  return { templates: [...builtins, ...own], projectKeys, refusals };
}

export function findTemplate(
  templates: readonly WorkflowTemplate[],
  ref: TemplateRef,
): WorkflowTemplate | null {
  return templates.find((t) => t.id === ref.id && t.version === ref.version) ?? null;
}

/** The band a step sits in: the one it names, else its type's home band. */
export function bandOfNode(
  template: WorkflowTemplate,
  node: { type: string; band?: string | undefined },
): string | null {
  if (node.band !== undefined) return node.band;
  return template.nodeTypes.find((n) => n.id === node.type)?.band ?? null;
}
