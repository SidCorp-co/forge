import { z } from 'zod';
import { repoPath } from '../ecosystem/link-schema.js';
import { SCHEMA_BASE, STOREFRONT_PROVIDERS, slug, uuid } from '../project-config/schema.js';

export const WORKFLOW_SCHEMA_ID = `${SCHEMA_BASE}/workflow-v1.json`;
export const WORKFLOW_V2_SCHEMA_ID = `${SCHEMA_BASE}/workflow-v2.json`;
export const WORKFLOW_VERSIONS = [1, 2] as const;

export const WORKFLOW_KINDS = ['flow', 'state'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const WORKFLOW_STATUSES = ['writing', 'current', 'rechecking'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

// cm:why `designed` is a step drawn before any code exists: version 2 only, and the one status that owes no evidence by right
export const WORKFLOW_V2_STATUSES = [...WORKFLOW_STATUSES, 'designed'] as const;
export type WorkflowV2Status = (typeof WORKFLOW_V2_STATUSES)[number];

// cm:why the journey node types a storefront design is drawn in (HOP's EVENT…OUTCOME), plus STEP for a plain code step
export const WORKFLOW_NODE_TYPES = [
  'EVENT',
  'CONTEXT',
  'RULE',
  'STATE',
  'EXPECTATION',
  'CASE',
  'TASK',
  'ATTENTION',
  'ACTION',
  'OUTCOME',
  'STEP',
] as const;

// cm:why a `flow` edge is a line `after` draws and orders; a `feedback` edge returns from a later step to an earlier one (an OUTCOME re-evaluating a RULE), so it orders nothing and is never part of the cycle check
export const WORKFLOW_EDGE_KINDS = ['flow', 'feedback'] as const;
export type WorkflowEdgeKind = (typeof WORKFLOW_EDGE_KINDS)[number];

export const STOREFRONT_REF_KINDS = ['workflow', 'route', 'node'] as const;

export const COVERAGE_READINGS = ['walked', 'not_walked', 'unmeasured'] as const;

export const WORKFLOW_LIMITS = {
  title: 120,
  summary: 400,
  does: 600,
  symbol: 200,
  reason: 400,
  steps: 40,
  after: 12,
  edges: 120,
  purpose: 400,
  io: 20,
  ioName: 120,
  owner: 120,
  sla: 60,
  contract: 400,
  mapping: 40,
  ref: 200,
} as const;

// cm:why a step id is a status name as often as a verb, so it takes `_` (`in_progress`) where a flow slug does not
export const STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/;
// cm:why the annotation is the `cm:flow <flow>/<step>` id written in the code, so evidence names the same string the flow-coverage checker reads
export const FLOW_STEP_ID = /^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9_-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;

const sha = () => z.string().regex(SHA);
const stepId = () => z.string().regex(STEP_ID);
const timestamp = () => z.iso.datetime({ offset: true });

const coverageSchema = z.strictObject({
  reading: z.enum(COVERAGE_READINGS),
  atSha: sha().nullable(),
});

const evidenceSchema = z.strictObject({
  file: repoPath(),
  symbol: z.string().min(1).max(WORKFLOW_LIMITS.symbol).optional(),
  annotation: z.string().regex(FLOW_STEP_ID).optional(),
  coverage: coverageSchema,
});

export const workflowStepSchema = z.strictObject({
  id: stepId(),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title).optional(),
  does: z.string().min(1).max(WORKFLOW_LIMITS.does),
  status: z.enum(WORKFLOW_STATUSES),
  after: z.array(stepId()).max(WORKFLOW_LIMITS.after),
  evidence: evidenceSchema.nullable(),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

const driftSchema = z.strictObject({
  sha: sha(),
  steps: z.array(stepId()).min(1).max(WORKFLOW_LIMITS.steps),
  reason: z.string().min(1).max(WORKFLOW_LIMITS.reason),
});

const workflowFields = {
  $schema: z.literal(WORKFLOW_SCHEMA_ID),
  version: z.literal(1),
  project: uuid(),
  flow: slug(),
  kind: z.enum(WORKFLOW_KINDS),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title),
  summary: z.string().min(1).max(WORKFLOW_LIMITS.summary),
  status: z.enum(WORKFLOW_STATUSES),
  steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_LIMITS.steps),
  drift: driftSchema.nullable(),
  writtenBy: z.strictObject({ runId: uuid().optional(), sessionId: uuid().optional(), sha: sha() }),
  refreshedAtSha: sha(),
};

export const workflowWriteSchema = z.strictObject(workflowFields);
export type WorkflowWriteV1 = z.infer<typeof workflowWriteSchema>;

const stamps = { id: uuid(), createdAt: timestamp(), updatedAt: timestamp() };

export const workflowDocumentSchema = z.strictObject({ ...workflowFields, ...stamps });
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;

const contractText = () => z.string().min(1).max(WORKFLOW_LIMITS.contract);
const ioList = () =>
  z.array(z.string().min(1).max(WORKFLOW_LIMITS.ioName)).max(WORKFLOW_LIMITS.io).optional();

const nodeSchema = z.strictObject({
  type: z.enum(WORKFLOW_NODE_TYPES),
  purpose: z.string().min(1).max(WORKFLOW_LIMITS.purpose).optional(),
  inputs: ioList(),
  outputs: ioList(),
  owner: z.string().min(1).max(WORKFLOW_LIMITS.owner).optional(),
  sla: z.string().min(1).max(WORKFLOW_LIMITS.sla).optional(),
});

const repoEvidenceSchema = z.strictObject({
  kind: z.literal('repo'),
  file: repoPath(),
  symbol: z.string().min(1).max(WORKFLOW_LIMITS.symbol).optional(),
  annotation: z.string().regex(FLOW_STEP_ID).optional(),
  coverage: coverageSchema,
});

// cm:why a storefront project has no checkout: its evidence is the provider's own artefact id, stored as written and never resolved here
const storefrontEvidenceSchema = z.strictObject({
  kind: z.literal('storefront'),
  provider: z.enum(STOREFRONT_PROVIDERS),
  ref: z.enum(STOREFRONT_REF_KINDS),
  id: z.string().min(1).max(WORKFLOW_LIMITS.ref),
  coverage: coverageSchema.optional(),
});

export const EVIDENCE_KINDS = ['repo', 'storefront'] as const;

const evidenceV2Schema = z.discriminatedUnion('kind', [
  repoEvidenceSchema,
  storefrontEvidenceSchema,
]);

export const workflowStepV2Schema = z.strictObject({
  id: stepId(),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title).optional(),
  does: z.string().min(1).max(WORKFLOW_LIMITS.does),
  status: z.enum(WORKFLOW_V2_STATUSES),
  after: z.array(stepId()).max(WORKFLOW_LIMITS.after),
  evidence: evidenceV2Schema.nullable(),
  node: nodeSchema.optional(),
});
export type WorkflowStepV2 = z.infer<typeof workflowStepV2Schema>;

const edgeSchema = z.strictObject({
  kind: z.enum(WORKFLOW_EDGE_KINDS).optional(),
  from: stepId(),
  to: stepId(),
  reevaluates: contractText().optional(),
  condition: contractText().optional(),
  action: contractText().optional(),
  mapping: z
    .record(z.string().min(1).max(WORKFLOW_LIMITS.ioName), z.string().max(WORKFLOW_LIMITS.contract))
    .refine((m) => Object.keys(m).length <= WORKFLOW_LIMITS.mapping, {
      message: `a mapping names at most ${WORKFLOW_LIMITS.mapping} fields`,
    })
    .optional(),
  idempotency: contractText().optional(),
  onFailure: contractText().optional(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

/** An edge's kind as written; an edge that names none is a `flow` edge, as every edge was before kinds. */
export const edgeKindOf = (edge: Pick<WorkflowEdge, 'kind'>): WorkflowEdgeKind =>
  edge.kind ?? 'flow';

const workflowV2Fields = {
  ...workflowFields,
  $schema: z.literal(WORKFLOW_V2_SCHEMA_ID),
  version: z.literal(2),
  status: z.enum(WORKFLOW_V2_STATUSES),
  steps: z.array(workflowStepV2Schema).min(1).max(WORKFLOW_LIMITS.steps),
  edges: z.array(edgeSchema).max(WORKFLOW_LIMITS.edges).optional(),
  writtenBy: z.strictObject({
    runId: uuid().optional(),
    sessionId: uuid().optional(),
    sha: sha().optional(),
  }),
  refreshedAtSha: sha().nullable(),
};

export const workflowWriteV2Schema = z.strictObject(workflowV2Fields);
export type WorkflowWriteV2 = z.infer<typeof workflowWriteV2Schema>;

export const workflowDocumentV2Schema = z.strictObject({ ...workflowV2Fields, ...stamps });

export type WorkflowWrite = WorkflowWriteV1 | WorkflowWriteV2;
export type AnyWorkflowStep = WorkflowStep | WorkflowStepV2;

export const stepsOf = (doc: WorkflowWrite): readonly AnyWorkflowStep[] => doc.steps;

/** What a step's evidence is, read the same way for both versions: version 1 knows only a repo file. */
export function evidenceKindOf(
  evidence: NonNullable<AnyWorkflowStep['evidence']>,
): (typeof EVIDENCE_KINDS)[number] {
  return 'kind' in evidence ? evidence.kind : 'repo';
}

/** The stored document read back by the version it was written at; never a guess at another. */
export function readStoredWorkflow(raw: unknown): WorkflowWrite | null {
  const version = (raw as { version?: unknown } | null)?.version;
  const parsed =
    version === 2 ? workflowWriteV2Schema.safeParse(raw) : workflowWriteSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
