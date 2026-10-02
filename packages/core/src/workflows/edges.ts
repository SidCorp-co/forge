import { pointer } from '../project-config/documents.js';
import type { WorkflowRefusal } from './rules.js';
import {
  type AnyWorkflowStep,
  edgeKindOf,
  stepsOf,
  type WorkflowEdge,
  type WorkflowWrite,
} from './schema.js';

const FEEDBACK_CONTRACT = ['condition', 'action', 'mapping', 'idempotency', 'onFailure'] as const;

/** Every step `id` comes after, however far back; a loop in `after` is refused elsewhere and ends the walk here. */
function earlierThan(steps: readonly AnyWorkflowStep[], id: string): Set<string> {
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

// cm:why a feedback edge is the one line allowed to run backwards, so it pays for that with a full contract and a named re-evaluation; one that runs forwards is an ordinary edge wearing the wrong kind
function feedbackRefusals(doc: WorkflowWrite, e: WorkflowEdge, j: number): WorkflowRefusal[] {
  if (edgeKindOf(e) === 'flow') {
    return e.reevaluates === undefined
      ? []
      : [
          {
            code: 'WORKFLOW_EDGE_REEVALUATES_ON_FLOW',
            path: pointer(['edges', j, 'reevaluates']),
            detail: `flow edge ${e.from} → ${e.to} names what it re-evaluates; only a \`kind: "feedback"\` edge returns to an earlier step to re-evaluate it.`,
          },
        ];
  }
  if (!earlierThan(stepsOf(doc), e.from).has(e.to)) {
    return [
      {
        code: 'WORKFLOW_FEEDBACK_EDGE_FORWARD',
        path: pointer(['edges', j, 'kind']),
        detail: `feedback edge ${e.from} → ${e.to} does not return: "${e.to}" is not a step "${e.from}" comes after. A feedback edge goes from a later step back to an earlier one; a line forward is a flow edge, drawn by listing "${e.from}" in step "${e.to}"'s \`after\` and dropping \`kind: "feedback"\`.`,
      },
    ];
  }
  const out: WorkflowRefusal[] = [];
  if (e.reevaluates === undefined) {
    out.push({
      code: 'WORKFLOW_FEEDBACK_REEVALUATES_MISSING',
      path: pointer(['edges', j, 'reevaluates']),
      detail: `feedback edge ${e.from} → ${e.to} names nothing it re-evaluates; \`reevaluates\` says what the return recomputes at "${e.to}" (e.g. "follow-up rule against the updated context").`,
    });
  }
  const absent = FEEDBACK_CONTRACT.filter((k) => e[k] === undefined);
  if (absent.length > 0) {
    out.push({
      code: 'WORKFLOW_FEEDBACK_CONTRACT_INCOMPLETE',
      path: pointer(['edges', j]),
      detail: `feedback edge ${e.from} → ${e.to} carries no ${absent.join(', ')}; a line that runs backwards carries its whole contract (${FEEDBACK_CONTRACT.join(', ')}), because a return with no idempotency or failure path is how a loop runs for ever.`,
    });
  }
  return out;
}

export function edgeRefusals(doc: WorkflowWrite): WorkflowRefusal[] {
  if (doc.version !== 2 || !doc.edges) return [];
  const byId = new Map(doc.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  return doc.edges.flatMap((e, j): WorkflowRefusal[] => {
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
    if (edgeKindOf(e) === 'feedback') return feedbackRefusals(doc, e, j);
    return byId.get(e.to)?.after.includes(e.from)
      ? feedbackRefusals(doc, e, j)
      : [
          {
            code: 'WORKFLOW_EDGE_UNDRAWN',
            path: pointer(['edges', j]),
            detail: `edge ${e.from} → ${e.to} carries a contract for a line the steps do not draw; step "${e.to}" lists "${e.from}" in its \`after\` first. A line back to an earlier step is not drawn in \`after\`: it is a \`kind: "feedback"\` edge.`,
          },
        ];
  });
}
