// The checks a template is held to — its own consistency, an extension over its base, its links to
// the other templates — and the reads every consumer shares: a project's templates resolved, a
// line's kind, a step's band.

import {
  isTemplateExtension,
  type ProjectWorkflowTemplate,
  type TemplateEdgeKind,
  type TemplateRef,
  type TemplateRefusal,
  type TemplateRule,
  WORKFLOW_TEMPLATE_SCHEMA_ID,
  type WorkflowTemplate,
  type WorkflowTemplateExtension,
} from './workflow-template-schema.js';

const at = (base: string, ...rest: (string | number)[]) =>
  [base, ...rest.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))].join('/');

const refKey = (r: TemplateRef) => `${r.id}@${r.version}`;

function duplicates(ids: readonly string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/** A complete template held to its own consistency: every id it names, it declares. */
function templateConsistencyRefusals(t: WorkflowTemplate, base = ''): TemplateRefusal[] {
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
  t.nodeTypes.forEach((n, i) => {
    for (const side of ['in', 'out'] as const) {
      (n.lines?.[side] ?? []).forEach((r, j) => {
        if (r.kind !== undefined && !kindIds.has(r.kind))
          bad(
            at(base, 'nodeTypes', i, 'lines', side, j, 'kind'),
            `node type ${n.id} counts ${side} lines of kind "${r.kind}", which is none of its edge kinds.`,
          );
        if (r.max !== undefined && r.max < r.min)
          bad(
            at(base, 'nodeTypes', i, 'lines', side, j),
            `node type ${n.id} owes at least ${r.min} and at most ${r.max} ${side} lines.`,
          );
      });
    }
    if (n.count?.min !== undefined && n.count.max !== undefined && n.count.max < n.count.min)
      bad(
        at(base, 'nodeTypes', i, 'count'),
        `node type ${n.id} owes at least ${n.count.min} and at most ${n.count.max} steps.`,
      );
    if (n.vocabulary && !n.required.includes('mapsTo'))
      bad(
        at(base, 'nodeTypes', i, 'vocabulary'),
        `node type ${n.id} closes the values of \`mapsTo\` and does not require it; require \`mapsTo\`, or drop the vocabulary.`,
      );
    for (const d of duplicates((n.links ?? []).map((l) => l.template)))
      bad(at(base, 'nodeTypes', i, 'links'), `node type ${n.id} links to ${d} twice.`);
  });
  const needs: [TemplateRule, string[], string[]][] = [
    ['screen-states', ['SCREEN', 'UI_STATE'], ['shows']],
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
function applyExtension(
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

/** Whether a design drawn in `t` answers a link to `id`: it is that template, or a preset of it. */
export const answersLink = (t: Pick<WorkflowTemplate, 'id' | 'presetOf'>, id: string) =>
  t.id === id || t.presetOf === id;

/** A template's links and preset held to the other templates: each names a template, and types it declares. */
function templateLinkRefusals(
  t: WorkflowTemplate,
  all: readonly WorkflowTemplate[],
  base = '',
): TemplateRefusal[] {
  const out: TemplateRefusal[] = [];
  const ids = [...new Set(all.map((x) => x.id))];
  if (t.presetOf !== undefined && (t.presetOf === t.id || !ids.includes(t.presetOf)))
    out.push({
      code: 'WORKFLOW_TEMPLATE_INVALID',
      path: at(base, 'presetOf'),
      detail: `template ${t.id}@${t.version} is a preset of "${t.presetOf}", which is ${t.presetOf === t.id ? 'itself' : `no template (known: ${ids.join(', ')})`}.`,
    });
  t.nodeTypes.forEach((n, i) => {
    (n.links ?? []).forEach((l, j) => {
      const targets = all.filter((x) => answersLink(x, l.template));
      if (targets.length === 0) {
        out.push({
          code: 'WORKFLOW_TEMPLATE_INVALID',
          path: at(base, 'nodeTypes', i, 'links', j, 'template'),
          detail: `template ${t.id}@${t.version}: node type ${n.id} links to "${l.template}", which is no template (known: ${ids.join(', ')}).`,
        });
        return;
      }
      const declared = new Set(targets.flatMap((x) => x.nodeTypes.map((y) => y.id)));
      l.types.forEach((ty, k) => {
        if (!declared.has(ty))
          out.push({
            code: 'WORKFLOW_TEMPLATE_INVALID',
            path: at(base, 'nodeTypes', i, 'links', j, 'types', k),
            detail: `template ${t.id}@${t.version}: node type ${n.id} links to a ${ty} of ${l.template}, which declares no ${ty} (its types: ${[...declared].join(', ')}).`,
          });
      });
    });
  });
  return out;
}

/** What `lineKindOf` reads a line as: one kind, or why none is. */
export type LineKind = { kind: string } | { none: true } | { ambiguous: string[] };

/**
 * The kind of a forward line that names none, read from its endpoint types: the one forward kind
 * whose `fromTypes`/`toTypes` admit both ends. A kind that names types beats one that names none;
 * left with several, the template's `defaultEdgeKind` if it is one of them, else the line is
 * ambiguous and names its kind itself.
 */
export function lineKindOf(
  t: WorkflowTemplate,
  fromType: string | null,
  toType: string | null,
): LineKind {
  const admits = (allowed: readonly string[] | undefined, ty: string | null) =>
    !allowed || (ty !== null && allowed.includes(ty));
  const fits = t.edgeKinds.filter(
    (k) => k.direction === 'forward' && admits(k.fromTypes, fromType) && admits(k.toTypes, toType),
  );
  const typed = fits.filter((k) => k.fromTypes || k.toTypes);
  const pool = typed.length > 0 ? typed : fits;
  if (pool.length === 1) return { kind: (pool[0] as TemplateEdgeKind).id };
  if (pool.length === 0) return { none: true };
  return pool.some((k) => k.id === t.defaultEdgeKind)
    ? { kind: t.defaultEdgeKind }
    : { ambiguous: pool.map((k) => k.id) };
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
  const all = [...builtins, ...own];
  const kept = own.filter((t) => {
    const index = declared.findIndex((d) => refKey(d) === refKey(t));
    const broken = templateLinkRefusals(t, all, at(base, index));
    refusals.push(...broken);
    if (broken.length > 0) projectKeys.delete(refKey(t));
    return broken.length === 0;
  });
  return { templates: [...builtins, ...kept], projectKeys, refusals };
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
