import {
  type LineKind,
  lineKindOf,
  type TemplateEdgeKind,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import { jsonPointer as pointer } from '../lib/refusal.js';
import type { WorkflowRefusal } from './rules.js';
import type { WorkflowEdge, WorkflowNode, WorkflowStepV2, WorkflowWriteV2 } from './schema.js';

/** Every step `id` comes after, however far back; a loop in `after` is refused elsewhere and ends the walk here. */
function earlierThan(steps: readonly WorkflowStepV2[], id: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = [...(byId.get(id)?.after ?? [])];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(byId.get(next)?.after ?? []));
  }
  return seen;
}

/** The node a step is drawn as: the one it names, else its template's default type. */
export function nodeOf(step: WorkflowStepV2, template: WorkflowTemplate): WorkflowNode | null {
  if (step.node) return step.node;
  return template.defaultNodeType ? { type: template.defaultNodeType } : null;
}

/** A step's type, when its template declares it; an undeclared one is refused at the node, not again at its lines. */
const typeIn = (doc: WorkflowWriteV2, template: WorkflowTemplate, id: string) => {
  const s = doc.steps.find((x) => x.id === id);
  const type = s ? (nodeOf(s, template)?.type ?? null) : null;
  return type && template.nodeTypes.some((n) => n.id === type) ? type : null;
};

/** A line of `kind` between these steps, refused when either end is a type the kind does not join. */
function endpointRefusals(
  doc: WorkflowWriteV2,
  from: string,
  to: string,
  kind: TemplateEdgeKind,
  template: WorkflowTemplate,
  path: string,
): WorkflowRefusal[] {
  return (
    [
      ['fromTypes', from, 'leave'],
      ['toTypes', to, 'reach'],
    ] as const
  ).flatMap(([side, id, verb]) => {
    const allowed = kind[side];
    const type = typeIn(doc, template, id);
    if (!allowed || type === null || allowed.includes(type)) return [];
    const fits = template.edgeKinds
      .filter((k) => (k[side] ?? [type]).includes(type) && k.direction === kind.direction)
      .map((k) => k.id);
    return [
      {
        code: 'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND' as const,
        path,
        detail: `${kind.id} line ${from} → ${to} would ${verb} a ${type} ("${id}"); a ${kind.id} line may ${verb} only ${allowed.join(', ')}.${fits.length ? ` A line that may ${verb} a ${type} is ${fits.join(' or ')}.` : ''}`,
      },
    ];
  });
}

/** The kind of the line `from` → `to` as its endpoint types read it (`lineKindOf`). */
export const impliedKind = (
  doc: WorkflowWriteV2,
  template: WorkflowTemplate,
  from: string,
  to: string,
): LineKind => lineKindOf(template, typeIn(doc, template, from), typeIn(doc, template, to));

/** An edge's kind: the one it names, else the one its endpoints imply; null when they imply none. */
function edgeKindOf(
  doc: WorkflowWriteV2,
  edge: Pick<WorkflowEdge, 'kind' | 'from' | 'to'>,
  template: WorkflowTemplate,
): string | null {
  if (edge.kind !== undefined) return edge.kind;
  const implied = impliedKind(doc, template, edge.from, edge.to);
  return 'kind' in implied ? implied.kind : null;
}

/** Every line the design draws with its kind: each `after` line, and each return edge. */
export function designLines(
  doc: WorkflowWriteV2,
  template: WorkflowTemplate,
): { from: string; to: string; kind: string | null }[] {
  const entries = new Map((doc.edges ?? []).map((e) => [`${e.from}\u0000${e.to}`, e]));
  const returns = new Set(
    template.edgeKinds.filter((k) => k.direction === 'return').map((k) => k.id),
  );
  const drawn = doc.steps.flatMap((s) =>
    s.after.map((a) => {
      const entry = entries.get(`${a}\u0000${s.id}`);
      return {
        from: a,
        to: s.id,
        kind: edgeKindOf(doc, entry ?? { from: a, to: s.id }, template),
      };
    }),
  );
  const back = (doc.edges ?? [])
    .filter((e) => e.kind !== undefined && returns.has(e.kind))
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind ?? null }));
  return [...drawn, ...back];
}

/** A line naming no kind whose endpoint types fit none of the template's kinds, or several. */
function unreadKind(
  doc: WorkflowWriteV2,
  template: WorkflowTemplate,
  from: string,
  to: string,
  path: string,
): WorkflowRefusal | null {
  const [a, b] = [typeIn(doc, template, from), typeIn(doc, template, to)];
  if (a === null || b === null) return null;
  const implied = impliedKind(doc, template, from, to);
  if ('kind' in implied) return null;
  const name = `template ${template.id}@${template.version}`;
  if ('ambiguous' in implied)
    return {
      code: 'WORKFLOW_EDGE_KIND_AMBIGUOUS',
      path,
      detail: `the line ${from} → ${to} (${a} → ${b}) could be ${implied.ambiguous.join(' or ')} in ${name}; name its kind in \`edges\`: { from: "${from}", to: "${to}", kind }.`,
    };
  const leave = template.edgeKinds.filter((k) => !k.fromTypes || (a && k.fromTypes.includes(a)));
  const reach = template.edgeKinds.filter((k) => !k.toTypes || (b && k.toTypes.includes(b)));
  return {
    code: 'WORKFLOW_EDGE_KIND_NONE',
    path,
    detail: `no line of ${name} joins a ${a} to a ${b} (${from} → ${to}); a ${a} may leave by ${leave.map((k) => k.id).join(', ') || 'no kind'}, and a ${b} may be reached by ${reach.map((k) => k.id).join(', ') || 'no kind'}.`,
  };
}

const listKinds = (kinds: readonly TemplateEdgeKind[]) =>
  kinds.map((k) => `${k.id} (${k.direction})`).join(', ');

const missingFields = (e: WorkflowEdge, kind: TemplateEdgeKind) =>
  kind.required.filter((f) => e[f] === undefined || (typeof e[f] === 'string' && !e[f]));

const isDrawn = (doc: WorkflowWriteV2, e: Pick<WorkflowEdge, 'from' | 'to'>) =>
  doc.steps.find((s) => s.id === e.to)?.after.includes(e.from) ?? false;

function undrawn(
  e: WorkflowEdge,
  j: number,
  kind: string,
  template: WorkflowTemplate,
): WorkflowRefusal {
  const returns = template.edgeKinds.filter((k) => k.direction === 'return');
  return {
    code: 'WORKFLOW_EDGE_UNDRAWN',
    path: pointer(['edges', j]),
    detail: `${kind} edge ${e.from} → ${e.to} carries a contract for a line the steps do not draw; step "${e.to}" lists "${e.from}" in its \`after\` first. A line back to an earlier step is not drawn in \`after\`: it is a return kind${returns.length ? ` (${returns.map((k) => k.id).join(', ')})` : `, and template ${template.id}@${template.version} declares none`}, named in the edge's \`kind\`.`,
  };
}

// cm:why a return edge is the one line allowed to run backwards, so it pays for that with what its template requires of it; one that runs forwards is an ordinary edge wearing the wrong kind
function directionRefusals(
  doc: WorkflowWriteV2,
  e: WorkflowEdge,
  j: number,
  kind: TemplateEdgeKind,
  template: WorkflowTemplate,
): WorkflowRefusal[] {
  if (kind.direction === 'forward') {
    const drawn = isDrawn(doc, e);
    const out: WorkflowRefusal[] = [];
    if (!drawn) out.push(undrawn(e, j, kind.id, template));
    if (drawn && e.reevaluates !== undefined) {
      out.push({
        code: 'WORKFLOW_EDGE_REEVALUATES_FORWARD',
        path: pointer(['edges', j, 'reevaluates']),
        detail: `${kind.id} edge ${e.from} → ${e.to} names what it re-evaluates, and ${kind.id} is a forward kind; only a return kind re-evaluates an earlier step.`,
      });
    }
    return out;
  }
  if (!earlierThan(doc.steps, e.from).has(e.to)) {
    return [
      {
        code: 'WORKFLOW_EDGE_RETURN_FORWARD',
        path: pointer(['edges', j, 'kind']),
        detail: `${kind.id} edge ${e.from} → ${e.to} does not return: "${e.to}" is not a step "${e.from}" comes after. A ${kind.id} edge goes from a later step back to an earlier one; a line forward is drawn by listing "${e.from}" in step "${e.to}"'s \`after\`, as a forward kind.`,
      },
    ];
  }
  return [];
}

export function edgeRefusals(doc: WorkflowWriteV2, template: WorkflowTemplate): WorkflowRefusal[] {
  const byId = new Map(doc.steps.map((s) => [s.id, s]));
  const kinds = new Map(template.edgeKinds.map((k) => [k.id, k]));
  const seen = new Set<string>();
  const carried = new Set<string>();
  const out = (doc.edges ?? []).flatMap((e, j): WorkflowRefusal[] => {
    const at = (key: string) => pointer(['edges', j, key]);
    const missing = (['from', 'to'] as const).filter((k) => !byId.has(e[k]));
    if (missing.length > 0) {
      return missing.map((k) => ({
        code: 'WORKFLOW_EDGE_DANGLING' as const,
        path: at(k),
        detail: `edge ${e.from} → ${e.to} names "${e[k]}", which is no step of this workflow.`,
      }));
    }
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) {
      return [
        {
          code: 'WORKFLOW_EDGE_DUPLICATE',
          path: pointer(['edges', j]),
          detail: `edge ${e.from} → ${e.to} carries its contract twice; one edge has one contract.`,
        },
      ];
    }
    seen.add(key);
    carried.add(key);
    if (e.kind === undefined) {
      if (!isDrawn(doc, e)) return [undrawn(e, j, 'the', template)];
      const unread = unreadKind(doc, template, e.from, e.to, pointer(['edges', j]));
      if (unread) return [unread];
      if (edgeKindOf(doc, e, template) === null) return [];
    }
    const kind = kinds.get(edgeKindOf(doc, e, template) ?? '');
    if (!kind) {
      return [
        {
          code: 'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE',
          path: at('kind'),
          detail: `edge ${e.from} → ${e.to} is kind "${e.kind}", which template ${template.id}@${template.version} does not declare; its kinds are ${listKinds(template.edgeKinds)}, and an edge that names none takes the kind its endpoint types imply.`,
        },
      ];
    }
    const direction = directionRefusals(doc, e, j, kind, template);
    if (direction.length > 0) return direction;
    const ends = endpointRefusals(doc, e.from, e.to, kind, template, pointer(['edges', j]));
    if (ends.length > 0) return ends;
    const absent = missingFields(e, kind);
    return absent.length === 0
      ? []
      : [
          {
            code: 'WORKFLOW_EDGE_FIELD_MISSING',
            path: pointer(['edges', j]),
            detail: `${kind.id} edge ${e.from} → ${e.to} carries no ${absent.join(', ')}; template ${template.id}@${template.version} requires a ${kind.id} edge to carry ${kind.required.join(', ')}.${kind.direction === 'return' ? ' A line that runs backwards carries its whole contract, because a return with no idempotency or failure path is how a loop runs for ever.' : ''}`,
          },
        ];
  });
  doc.steps.forEach((s, i) => {
    s.after.forEach((a, j) => {
      if (!byId.has(a) || carried.has(`${a}\u0000${s.id}`)) return;
      const path = pointer(['steps', i, 'after', j]);
      const unread = unreadKind(doc, template, a, s.id, path);
      if (unread) {
        out.push(unread);
        return;
      }
      const implicit = kinds.get(edgeKindOf(doc, { from: a, to: s.id }, template) ?? '');
      if (!implicit || implicit.required.length === 0) return;
      out.push({
        code: 'WORKFLOW_EDGE_FIELD_MISSING',
        path,
        detail: `the line ${a} → ${s.id} is a ${implicit.id} edge with no entry in \`edges\`; template ${template.id}@${template.version} requires a ${implicit.id} edge to carry ${implicit.required.join(', ')}, so declare { from: "${a}", to: "${s.id}", ${implicit.required.map((f) => `${f}`).join(', ')} } in \`edges\`.`,
      });
    });
  });
  return out;
}
