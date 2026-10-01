import { z } from 'zod';
import { repoPath } from '../ecosystem/link-schema.js';
import { SCHEMA_BASE, slug, uuid } from '../project-config/schema.js';

export const WORKFLOW_SCHEMA_ID = `${SCHEMA_BASE}/workflow-v1.json`;

export const WORKFLOW_KINDS = ['flow', 'state'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const WORKFLOW_STATUSES = ['writing', 'current', 'rechecking'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const COVERAGE_READINGS = ['walked', 'not_walked', 'unmeasured'] as const;

export const WORKFLOW_LIMITS = {
  title: 120,
  summary: 400,
  does: 600,
  symbol: 200,
  reason: 400,
  steps: 40,
  after: 12,
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
export type WorkflowWrite = z.infer<typeof workflowWriteSchema>;

export const workflowDocumentSchema = z.strictObject({
  ...workflowFields,
  id: uuid(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;
