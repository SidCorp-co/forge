import type { TemplateEdgeKind, WorkflowTemplate } from '@forge/contracts/workflow-templates';
import { pointer } from '../project-config/documents.js';
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

/** A line of `kind` between these steps, refused when either end is a type the kind does not join. */
function endpointRefusals(
  doc: WorkflowWriteV2,
  from: string,
  to: string,
  kind: TemplateEdgeKind,
  template: WorkflowTemplate,
  path: string,
): WorkflowRefusal[] {
  const typeOf = (id: string) => {
    const s = doc.steps.find((x) => x.id === id);
    return s ? (nodeOf(s, template)?.type ?? null) : null;
  };
  return (
    [
      ['fromTypes', from, 'leave'],
      ['toTypes', to, 'reach'],
    ] as const
  ).flatMap(([side, id, verb]) => {
    const allowed = kind[side];
    const type = typeOf(id);
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

/** An edge's kind as written; one that names none is its template's default kind. */
export const edgeKindOf = (edge: Pick<WorkflowEdge, 'kind'>, template: WorkflowTemplate): string =>
  edge.kind ?? template.defaultEdgeKind;

const listKinds = (kinds: readonly TemplateEdgeKind[]) =>
  kinds.map((k) => `${k.id} (${k.direction})`).join(', ');

const missingFields = (e: WorkflowEdge, kind: TemplateEdgeKind) =>
  kind.required.filter((f) => e[f] === undefined || (typeof e[f] === 'string' && !e[f]));

// cm:why a return edge is the one line allowed to run backwards, so it pays for that with what its template requires of it; one that runs forwards is an ordinary edge wearing the wrong kind
function directionRefusals(
  doc: WorkflowWriteV2,
  e: WorkflowEdge,
  j: number,
  kind: TemplateEdgeKind,
  template: WorkflowTemplate,
): WorkflowRefusal[] {
  const returns = template.edgeKinds.filter((k) => k.direction === 'return');
  if (kind.direction === 'forward') {
    const drawn = doc.steps.find((s) => s.id === e.to)?.after.includes(e.from) ?? false;
    const out: WorkflowRefusal[] = [];
    if (!drawn) {
      out.push({
        code: 'WORKFLOW_EDGE_UNDRAWN',
        path: pointer(['edges', j]),
        detail: `${kind.id} edge ${e.from} → ${e.to} carries a contract for a line the steps do not draw; step "${e.to}" lists "${e.from}" in its \`after\` first. A line back to an earlier step is not drawn in \`after\`: it is a return kind${returns.length ? ` (${returns.map((k) => k.id).join(', ')})` : `, and template ${template.id}@${template.version} declares none`}.`,
      });
    }
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
    const kind = kinds.get(edgeKindOf(e, template));
    if (!kind) {
      return [
        {
          code: 'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE',
          path: at('kind'),
          detail: `edge ${e.from} → ${e.to} is kind "${e.kind}", which template ${template.id}@${template.version} does not declare; its kinds are ${listKinds(template.edgeKinds)}, and an edge that names none is ${template.defaultEdgeKind}.`,
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
  const implicit = kinds.get(template.defaultEdgeKind);
  if (!implicit) return out;
  doc.steps.forEach((s, i) => {
    s.after.forEach((a, j) => {
      if (!byId.has(a) || carried.has(`${a}\u0000${s.id}`)) return;
      const ends = endpointRefusals(
        doc,
        a,
        s.id,
        implicit,
        template,
        pointer(['steps', i, 'after', j]),
      );
      if (ends.length > 0) {
        out.push(...ends);
        return;
      }
      if (implicit.required.length === 0) return;
      out.push({
        code: 'WORKFLOW_EDGE_FIELD_MISSING',
        path: pointer(['steps', i, 'after', j]),
        detail: `the line ${a} → ${s.id} is a ${implicit.id} edge with no entry in \`edges\`; template ${template.id}@${template.version} requires a ${implicit.id} edge to carry ${implicit.required.join(', ')}, so declare { from: "${a}", to: "${s.id}", ${implicit.required.map((f) => `${f}`).join(', ')} } in \`edges\`.`,
      });
    });
  });
  return out;
}
