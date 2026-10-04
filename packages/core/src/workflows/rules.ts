import { REPO_PATH_MESSAGE } from '@forge/contracts/repo-path';
import type { WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { WorkflowRefusalCode } from '@forge/contracts/workflows';
import { jsonPointer as pointer } from '../lib/refusal.js';
import { type ApiRefusal, isRecord, parseVersionedDocument } from '../project-config/index.js';
import {
  type AnyWorkflowStep,
  stepsOf,
  WORKFLOW_KINDS,
  type WorkflowWrite,
  workflowWriteV2Schema,
} from './schema.js';
import { type ProjectDesigns, templateOf, templateRefusals } from './template-check.js';

export interface WorkflowRefusal {
  code: WorkflowRefusalCode | ApiRefusal['code'];
  path: string;
  detail: string;
}

type CheckedWorkflow =
  | { ok: true; value: WorkflowWrite }
  | { ok: false; refusals: WorkflowRefusal[] };

const closed = (values: readonly string[]) => `one of ${values.join(' | ')}, and nothing else`;

const ENUM_RENAMES: readonly [RegExp, WorkflowRefusalCode, string][] = [
  [/^\/kind$/, 'WORKFLOW_KIND_UNKNOWN', `a workflow's kind is ${closed(WORKFLOW_KINDS)}`],
  [
    /^\/steps\/\d+\/node\/type$/,
    'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE',
    "a node's type is an upper-case id (EVENT, STATE, TASK) its template declares",
  ],
  [
    /^\/edges\/\d+\/kind$/,
    'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE',
    "an edge's kind is a lower-case id (flow, feedback, transition) its template declares; an edge that names none is the template's default kind",
  ],
  [
    /^\/template$/,
    'WORKFLOW_TEMPLATE_MISSING',
    'a version 2 design names the diagram template it is drawn in, `template: { id, version }` — e.g. { id: "operational-flow", version: 1 }; GET /api/workflow-templates lists the built-ins and GET /api/guides/workflow-templates.md says how to pick one',
  ],
];

function renameParseRefusals(refusals: readonly ApiRefusal[]): WorkflowRefusal[] {
  return refusals.map((r): WorkflowRefusal => {
    if (r.code !== 'SCHEMA_VIOLATION') return r;
    if (r.detail === REPO_PATH_MESSAGE) {
      return {
        code: 'PATH_OUTSIDE_REPO',
        path: r.path,
        detail: `${REPO_PATH_MESSAGE}; evidence names a file inside the project's checkout and is stored as written, never resolved.`,
      };
    }
    const hit = ENUM_RENAMES.find(([re]) => re.test(r.path));
    return hit ? { code: hit[1], path: r.path, detail: `${r.detail}; ${hit[2]}.` } : r;
  });
}

export function parseWorkflow(raw: unknown, projectId: string): CheckedWorkflow {
  const claimed = isRecord(raw) ? raw.project : undefined;
  const owner: WorkflowRefusal[] =
    claimed === undefined || claimed === projectId
      ? []
      : [
          {
            code: 'PROJECT_ID_IMMUTABLE',
            path: '/project',
            detail: `project ${JSON.stringify(claimed)} is not this project; a workflow written at /api/projects/${projectId} names ${projectId}.`,
          },
        ];
  // version 1 carried the code's reading inside the design; it is retired for writes, and that
  // reading is an observation now (observations.ts)
  const parsed = parseVersionedDocument<WorkflowWrite>(workflowWriteV2Schema, raw, 'workflow', [2]);
  if (!parsed.ok)
    return { ok: false, refusals: [...owner, ...renameParseRefusals(parsed.refusals)] };
  return owner.length > 0 ? { ok: false, refusals: owner } : parsed;
}

function duplicateSteps(steps: readonly AnyWorkflowStep[]): WorkflowRefusal[] {
  const seen = new Set<string>();
  const out: WorkflowRefusal[] = [];
  steps.forEach((s, i) => {
    if (seen.has(s.id)) {
      out.push({
        code: 'WORKFLOW_STEP_DUPLICATE',
        path: pointer(['steps', i, 'id']),
        detail: `step "${s.id}" is named twice; a step id is unique inside its workflow, because every \`after\` edge names one.`,
      });
    }
    seen.add(s.id);
  });
  return out;
}

function danglingAfter(steps: readonly AnyWorkflowStep[]): WorkflowRefusal[] {
  const ids = new Set(steps.map((s) => s.id));
  return steps.flatMap((s, i) =>
    s.after.flatMap((a, j) =>
      ids.has(a)
        ? []
        : [
            {
              code: 'WORKFLOW_AFTER_DANGLING' as const,
              path: pointer(['steps', i, 'after', j]),
              detail: `step "${s.id}" comes after "${a}", which is no step of this workflow (steps: ${[...ids].join(', ')}).`,
            },
          ],
    ),
  );
}

function cycleThrough(steps: readonly AnyWorkflowStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'open' | 'done'>();
  const trail: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 'open');
    trail.push(id);
    for (const a of byId.get(id)?.after ?? []) {
      if (!byId.has(a)) continue;
      const found = visit(a);
      if (found) return found;
    }
    trail.pop();
    state.set(id, 'done');
    return null;
  };
  for (const s of steps) {
    const found = visit(s.id);
    if (found) return found;
  }
  return null;
}

function afterCycle(steps: readonly AnyWorkflowStep[]): WorkflowRefusal[] {
  const cycle = cycleThrough(steps);
  if (!cycle) return [];
  const at = steps.findIndex((s) => s.id === cycle[0]);
  return [
    {
      code: 'WORKFLOW_AFTER_CYCLE',
      path: pointer(['steps', at, 'after']),
      detail: `the \`after\` edges close a loop (${[...cycle].reverse().join(' → ')}); a workflow's steps are ordered, so no step may come after itself. A return to an earlier step — an outcome that re-evaluates a rule, a reopened state — is not an \`after\` line: take it out of \`after\` and declare it in \`edges\` with a return kind of the design's template (operational-flow: \`{ kind: "feeds-back", from: <the outcome>, to: <the earlier context or state>, reevaluates, payload, idempotency, onFailure }\`; state-machine: \`{ kind: "back", from, to, label }\`), which orders nothing and is never part of this check.`,
    },
  ];
}

/** Where a project's evidence lives: its checkout, or the storefront provider it builds on. */
export type EvidenceSource = { kind: 'repo' } | { kind: 'storefront'; provider: string };

/** What a design is checked against beyond itself: the templates it may name, and the project's other designs. */
interface WorkflowCheckContext {
  /** The built-ins and the project's own. */
  templates: readonly WorkflowTemplate[];
  designs: ProjectDesigns;
}

/**
 * A workflow held to the kernel's order rules and, at version 2, to the template it names.
 */
export function checkWorkflow(doc: WorkflowWrite, ctx: WorkflowCheckContext): WorkflowRefusal[] {
  const steps = stepsOf(doc);
  const dup = duplicateSteps(steps);
  if (dup.length > 0) return dup;
  const dangling = danglingAfter(steps);
  const cycle = afterCycle(steps);
  return [...dangling, ...cycle, ...designRefusals(doc, ctx, cycle.length === 0)];
}

function designRefusals(
  doc: Extract<WorkflowWrite, { version: 2 }>,
  ctx: WorkflowCheckContext,
  ordered: boolean,
): WorkflowRefusal[] {
  const found = templateOf(doc, ctx.templates);
  return found.ok ? templateRefusals(doc, found.template, ctx, ordered) : [found.refusal];
}

export function workflowIdentityRefusals(
  stored: WorkflowWrite,
  next: WorkflowWrite,
): WorkflowRefusal[] {
  const pairs: [string, unknown, unknown][] = [
    ['/flow', stored.flow, next.flow],
    ['/kind', stored.kind, next.kind],
  ];
  return pairs
    .filter(([, was, now]) => was !== now)
    .map(([path, was]) => ({
      code: 'WORKFLOW_IDENTITY_IMMUTABLE' as const,
      path,
      detail: `a workflow is one flow of one kind, so ${path} stays ${JSON.stringify(was)}; write a new workflow instead.`,
    }));
}

export function duplicateWorkflowRefusal(flow: string, holding: string): WorkflowRefusal {
  return {
    code: 'WORKFLOW_DUPLICATE',
    path: '/flow',
    detail: `workflow ${holding} already draws flow "${flow}" for this project; a flow is drawn once and refreshed by PUT, not written again.`,
  };
}
