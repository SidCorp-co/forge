import type { WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { ProjectMemberRole } from '../db/schema.js';
import { REPO_PATH_MESSAGE } from '../ecosystem/link-schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { actMiss, PROJECT_AGENT_WRITE } from '../lib/person-act.js';
import {
  type ApiRefusal,
  isRecord,
  parseVersionedDocument,
  pointer,
} from '../project-config/documents.js';
import {
  type AnyWorkflowStep,
  COVERAGE_READINGS,
  EVIDENCE_KINDS,
  evidenceKindOf,
  stepsOf,
  WORKFLOW_KINDS,
  WORKFLOW_V2_STATUSES,
  WORKFLOW_VERSIONS,
  type WorkflowWrite,
  workflowWriteSchema,
  workflowWriteV2Schema,
} from './schema.js';
import { type ProjectDesigns, templateOf, templateRefusals } from './template-check.js';

export type WorkflowRefusalCode =
  | 'WORKFLOW_WRITER_NOT_PROJECT'
  | 'WORKFLOW_KIND_UNKNOWN'
  | 'WORKFLOW_STATUS_UNKNOWN'
  | 'WORKFLOW_COVERAGE_UNKNOWN'
  | 'WORKFLOW_COVERAGE_UNPINNED'
  | 'WORKFLOW_STEP_DUPLICATE'
  | 'WORKFLOW_AFTER_DANGLING'
  | 'WORKFLOW_AFTER_CYCLE'
  | 'WORKFLOW_ANNOTATION_MISMATCH'
  | 'WORKFLOW_EVIDENCE_MISSING'
  | 'WORKFLOW_STATUS_MISMATCH'
  | 'WORKFLOW_DRIFT_MISMATCH'
  | 'WORKFLOW_DRIFT_STEP_UNKNOWN'
  | 'WORKFLOW_EVIDENCE_KIND_UNKNOWN'
  | 'WORKFLOW_EVIDENCE_KIND_MISMATCH'
  | 'WORKFLOW_EDGE_DANGLING'
  | 'WORKFLOW_EDGE_UNDRAWN'
  | 'WORKFLOW_EDGE_DUPLICATE'
  | 'WORKFLOW_EDGE_RETURN_FORWARD'
  | 'WORKFLOW_EDGE_REEVALUATES_FORWARD'
  | 'WORKFLOW_EDGE_FIELD_MISSING'
  | 'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE'
  | 'WORKFLOW_TEMPLATE_MISSING'
  | 'WORKFLOW_TEMPLATE_UNKNOWN'
  | 'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE'
  | 'WORKFLOW_NODE_FIELD_MISSING'
  | 'WORKFLOW_BAND_MISMATCH'
  | 'WORKFLOW_TEMPLATE_RULE'
  | 'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND'
  | 'WORKFLOW_EDGE_KIND_NONE'
  | 'WORKFLOW_EDGE_KIND_AMBIGUOUS'
  | 'WORKFLOW_NODE_NOT_ENTRY'
  | 'WORKFLOW_NODE_TYPE_COUNT'
  | 'WORKFLOW_NODE_LINES'
  | 'WORKFLOW_NODE_FIELD_NOT_UNIQUE'
  | 'WORKFLOW_NODE_VALUE_NOT_IN_VOCABULARY'
  | 'WORKFLOW_REF_NOT_ALLOWED'
  | 'WORKFLOW_REF_DANGLING'
  | 'WORKFLOW_REF_TARGET_MISMATCH'
  | 'WORKFLOW_REF_MISSING'
  | 'WORKFLOW_BASE_SELF'
  | 'WORKFLOW_BASE_DUPLICATE'
  | 'WORKFLOW_BASE_UNKNOWN'
  | 'WORKFLOW_DUPLICATE'
  | 'WORKFLOW_IDENTITY_IMMUTABLE'
  | 'PATH_OUTSIDE_REPO'
  | 'PROJECT_ID_IMMUTABLE';

export interface WorkflowRefusal {
  code: WorkflowRefusalCode | ApiRefusal['code'];
  path: string;
  detail: string;
}

export type CheckedWorkflow =
  | { ok: true; value: WorkflowWrite }
  | { ok: false; refusals: WorkflowRefusal[] };

const closed = (values: readonly string[]) => `one of ${values.join(' | ')}, and nothing else`;

const ENUM_RENAMES: readonly [RegExp, WorkflowRefusalCode, string][] = [
  [/^\/kind$/, 'WORKFLOW_KIND_UNKNOWN', `a workflow's kind is ${closed(WORKFLOW_KINDS)}`],
  [
    /^(\/steps\/\d+)?\/status$/,
    'WORKFLOW_STATUS_UNKNOWN',
    `a workflow's and a step's status is ${closed(WORKFLOW_V2_STATUSES)}, \`designed\` at version 2 only`,
  ],
  [
    /^\/steps\/\d+\/node\/type$/,
    'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE',
    "a node's type is an upper-case id (EVENT, STATE, TASK) its template declares",
  ],
  [
    /^\/steps\/\d+\/evidence\/kind$/,
    'WORKFLOW_EVIDENCE_KIND_UNKNOWN',
    `a version 2 evidence names its kind, ${closed(EVIDENCE_KINDS)}`,
  ],
  [
    /^\/edges\/\d+\/kind$/,
    'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE',
    "an edge's kind is a lower-case id (flow, feedback, transition) its template declares; an edge that names none is the template's default kind",
  ],
  [
    /^\/template$/,
    'WORKFLOW_TEMPLATE_MISSING',
    'a version 2 design names the diagram template it is drawn in, `template: { id, version }` — e.g. { id: "operational-flow", version: 1 }; GET /api/workflow-templates lists the built-ins and forge_guide get workflow-templates says how to pick one',
  ],
  [
    /^\/steps\/\d+\/evidence\/coverage\/reading$/,
    'WORKFLOW_COVERAGE_UNKNOWN',
    `a coverage reading is ${closed(COVERAGE_READINGS)}`,
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
  const v2 = isRecord(raw) && raw.version === 2;
  const parsed = v2
    ? parseVersionedDocument<WorkflowWrite>(
        workflowWriteV2Schema,
        raw,
        'workflow',
        WORKFLOW_VERSIONS,
      )
    : parseVersionedDocument<WorkflowWrite>(
        workflowWriteSchema,
        raw,
        'workflow',
        WORKFLOW_VERSIONS,
      );
  if (!parsed.ok)
    return { ok: false, refusals: [...owner, ...renameParseRefusals(parsed.refusals)] };
  return owner.length > 0 ? { ok: false, refusals: owner } : parsed;
}

export interface WorkflowWriterFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
}

// cm:why a diagram is the project's own reading of its own code, like an ecosystem link: only that project's agent (its master or a run it dispatched) writes it, never a person and never another project's agent
export function workflowWriterRefusal(
  facts: WorkflowWriterFacts,
  projectId: string,
): WorkflowRefusal | null {
  const miss = actMiss(facts, PROJECT_AGENT_WRITE);
  if (!miss) return null;
  const held =
    miss.kind === 'person-not-allowed'
      ? `${facts.userId} acts as a person`
      : `agent ${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}`;
  return {
    code: 'WORKFLOW_WRITER_NOT_PROJECT',
    path: '',
    detail: `${held}; a workflow is written only by project ${projectId}'s own agent holding member or above, through a token that reaches the project. Nothing generates it and no person edits it.`,
  };
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

function evidenceRefusals(doc: WorkflowWrite): WorkflowRefusal[] {
  return stepsOf(doc).flatMap((s, i): WorkflowRefusal[] => {
    const at = (...rest: (string | number)[]) => pointer(['steps', i, ...rest]);
    if (!s.evidence) {
      return doc.kind === 'flow' && s.status !== 'writing' && s.status !== 'designed'
        ? [
            {
              code: 'WORKFLOW_EVIDENCE_MISSING',
              path: at('evidence'),
              detail: `flow step "${s.id}" is ${s.status} and names no evidence; only a step still being written, or one designed and not yet built, may stand without evidence.`,
            },
          ]
        : [];
    }
    const out: WorkflowRefusal[] = [];
    if (!('file' in s.evidence)) {
      const { coverage } = s.evidence;
      if (coverage) out.push(...coverageRefusals(coverage, at));
      return out;
    }
    const expected = `${doc.flow}/${s.id}`;
    if (s.evidence.annotation !== undefined && s.evidence.annotation !== expected) {
      out.push({
        code: 'WORKFLOW_ANNOTATION_MISMATCH',
        path: at('evidence', 'annotation'),
        detail: `step "${s.id}" of flow "${doc.flow}" cites \`cm:flow ${s.evidence.annotation}\`; its annotation is \`cm:flow ${expected}\`, the id written in the code.`,
      });
    }
    out.push(...coverageRefusals(s.evidence.coverage, at));
    return out;
  });
}

function coverageRefusals(
  { reading, atSha }: { reading: string; atSha: string | null },
  at: (...rest: (string | number)[]) => string,
): WorkflowRefusal[] {
  if ((reading === 'unmeasured') === (atSha === null)) return [];
  return [
    {
      code: 'WORKFLOW_COVERAGE_UNPINNED',
      path: at('evidence', 'coverage', 'atSha'),
      detail:
        reading === 'unmeasured'
          ? `an unmeasured step names no commit; atSha is null until a coverage report has read it.`
          : `a ${reading} reading says which commit's integration report it came from; atSha is that sha.`,
    },
  ];
}

/** Where a project's evidence lives: its checkout, or the storefront provider it builds on. */
export type EvidenceSource = { kind: 'repo' } | { kind: 'storefront'; provider: string };

// cm:why a storefront project has no repository, so a file path there names nothing; a repo project has no provider artefact. Either crossed is refused by name rather than stored as a reference nobody can follow
export function evidenceSourceRefusals(
  doc: WorkflowWrite,
  source: EvidenceSource,
): WorkflowRefusal[] {
  return stepsOf(doc).flatMap((s, i): WorkflowRefusal[] => {
    if (!s.evidence) return [];
    const kind = evidenceKindOf(s.evidence);
    const provider = 'provider' in s.evidence ? s.evidence.provider : null;
    const fits =
      kind === source.kind && (source.kind !== 'storefront' || provider === source.provider);
    if (fits) return [];
    const wanted =
      source.kind === 'storefront'
        ? `a ${source.provider} artefact ({ kind: "storefront", provider: "${source.provider}", ref: workflow | route | node, id })`
        : 'a file in its checkout ({ kind: "repo", file, coverage })';
    const held = kind === 'repo' ? 'a repository file' : `a ${provider} storefront artefact`;
    return [
      {
        code: 'WORKFLOW_EVIDENCE_KIND_MISMATCH',
        path: pointer(['steps', i, 'evidence']),
        detail: `step "${s.id}" names ${held} as evidence; this project's source is ${source.kind === 'storefront' ? `a ${source.provider} storefront` : 'a repository'}, so its evidence is ${wanted}.`,
      },
    ];
  });
}

function statusRefusals(doc: WorkflowWrite): WorkflowRefusal[] {
  const by = (st: string) =>
    stepsOf(doc)
      .filter((s) => s.status === st)
      .map((s) => s.id);
  const designed = by('designed');
  const writing = by('writing');
  const rechecking = by('rechecking');
  const wrong = (detail: string): WorkflowRefusal[] => [
    { code: 'WORKFLOW_STATUS_MISMATCH', path: '/status', detail },
  ];
  const unbuilt = [...designed, ...writing, ...rechecking];
  if (doc.status === 'current' && unbuilt.length > 0) {
    return wrong(
      `a current workflow has every step current; ${unbuilt.join(', ')} ${unbuilt.length === 1 ? 'is' : 'are'} not.`,
    );
  }
  if (doc.status === 'designed' && designed.length !== doc.steps.length) {
    return wrong(
      'a designed workflow has every step designed; once one is built the workflow is being written.',
    );
  }
  if (doc.status === 'writing' && writing.length + designed.length === 0) {
    return wrong('a workflow being written has at least one step being written or still designed.');
  }
  if (doc.status === 'rechecking' && rechecking.length === 0) {
    return wrong('a workflow being re-checked has at least one step being re-checked.');
  }
  return [];
}

function driftRefusals(doc: WorkflowWrite): WorkflowRefusal[] {
  if ((doc.drift === null) !== (doc.status !== 'rechecking')) {
    return [
      {
        code: 'WORKFLOW_DRIFT_MISMATCH',
        path: '/drift',
        detail:
          doc.drift === null
            ? 'a workflow being re-checked names its drift: the sha that moved the code and the steps it moved under.'
            : `a ${doc.status} workflow carries no drift; drift is what a re-check is reading, and it clears when the steps are current again.`,
      },
    ];
  }
  if (!doc.drift) return [];
  const byId = new Map(stepsOf(doc).map((s) => [s.id, s]));
  return doc.drift.steps.flatMap((id, j): WorkflowRefusal[] => {
    const step = byId.get(id);
    if (!step) {
      return [
        {
          code: 'WORKFLOW_DRIFT_STEP_UNKNOWN',
          path: pointer(['drift', 'steps', j]),
          detail: `drift names "${id}", which is no step of this workflow.`,
        },
      ];
    }
    return step.status === 'rechecking'
      ? []
      : [
          {
            code: 'WORKFLOW_DRIFT_MISMATCH',
            path: pointer(['drift', 'steps', j]),
            detail: `drift names "${id}", whose status is ${step.status}; a step the code moved under is rechecking until it is read again.`,
          },
        ];
  });
}

/** What a design is checked against beyond itself: the templates it may name, and the project's other designs. */
export interface WorkflowCheckContext {
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
  return [
    ...dangling,
    ...cycle,
    ...(doc.version === 2 ? designRefusals(doc, ctx, cycle.length === 0) : []),
    ...evidenceRefusals(doc),
    ...statusRefusals(doc),
    ...driftRefusals(doc),
  ];
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
