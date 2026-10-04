import { SCHEMA_BASE } from '@forge/contracts/project-config';
import {
  BAND_ID,
  EDGE_KIND_ID,
  NODE_TYPE_ID,
  TEMPLATE_ID,
  TEMPLATE_LIMITS,
  templateRefSchema,
} from '@forge/contracts/workflow-templates';
import { z } from 'zod';
import { slug, uuid } from '../project-config/index.js';

export const WORKFLOW_V2_SCHEMA_ID = `${SCHEMA_BASE}/workflow-v2.json`;

export const WORKFLOW_KINDS = ['flow', 'state'] as const;

// cm:why a node's type and an edge's kind are no longer one global list: the template a design names
// declares them (`@forge/contracts/workflow-templates`), so the schema holds only their shape and
// `template-check.ts` refuses one its template does not declare
const NODE_TYPE = NODE_TYPE_ID;
const EDGE_KIND = EDGE_KIND_ID;

const UI_STATE_VARIANTS = ['empty', 'loading', 'error', 'success', 'partial'] as const;

/** operational-flow: an event is named `domain.verb_past` (`patient.discharged`). */
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

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
  label: TEMPLATE_LIMITS.label,
  conditions: 30,
  tests: 30,
  lanes: 16,
  refs: 8,
  bases: 8,
  route: 200,
  values: 20,
  code: 40,
  protocol: 60,
} as const;

// cm:why a step id is a status name as often as a verb, so it takes `_` (`in_progress`) where a flow slug does not
export const STEP_ID = /^[a-z][a-z0-9_-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;

const sha = () => z.string().regex(SHA);
const stepId = () => z.string().regex(STEP_ID);
const timestamp = () => z.iso.datetime({ offset: true });

const stamps = { id: uuid(), createdAt: timestamp(), updatedAt: timestamp() };

const contractText = () => z.string().min(1).max(WORKFLOW_LIMITS.contract);
const ioList = () =>
  z.array(z.string().min(1).max(WORKFLOW_LIMITS.ioName)).max(WORKFLOW_LIMITS.io).optional();

const conditionRow = z.strictObject({
  when: contractText(),
  result: contractText(),
});

const textList = (max: number) =>
  z.array(z.string().min(1).max(WORKFLOW_LIMITS.contract)).max(max).optional();

export const nodeSchema = z.strictObject({
  type: z.string().regex(NODE_TYPE),
  /** The short business title an approver reads on the card; absent, the step's `title` is shown. */
  label: z.string().min(1).max(WORKFLOW_LIMITS.label).optional(),
  /** The band (or the design's lane) the step sits in; absent, its type's home band. */
  band: z.string().regex(BAND_ID).optional(),
  purpose: z.string().min(1).max(WORKFLOW_LIMITS.purpose).optional(),
  inputs: ioList(),
  outputs: ioList(),
  owner: z.string().min(1).max(WORKFLOW_LIMITS.owner).optional(),
  sla: z.string().min(1).max(WORKFLOW_LIMITS.sla).optional(),
  /** A rule table: each row is `when` a condition holds, the `result`. */
  conditions: z.array(conditionRow).max(WORKFLOW_LIMITS.conditions).optional(),
  /** The cases the rule table is checked against, each an input and the answer it must give. */
  tests: textList(WORKFLOW_LIMITS.tests),
  expectedOutcome: contractText().optional(),
  permissions: textList(WORKFLOW_LIMITS.io),
  /** ux-flow: the persona (one of the design's `personas`) a screen is for. */
  persona: z.string().regex(BAND_ID).optional(),
  /** ux-flow: the wireframe-v1 board drawn for a screen, as the issue attachments holding it. */
  wireframe: z.strictObject({ attachment: uuid(), svg: uuid().optional() }).optional(),
  dataShown: textList(WORKFLOW_LIMITS.io),
  actions: textList(WORKFLOW_LIMITS.io),
  trigger: contractText().optional(),
  validation: contractText().optional(),
  variant: z.enum(UI_STATE_VARIANTS).optional(),
  event: z.string().regex(EVENT_NAME).max(WORKFLOW_LIMITS.ioName).optional(),
  /** ux-flow: the path a screen is served at. */
  route: z.string().regex(/^\//).max(WORKFLOW_LIMITS.route).optional(),
  payload: ioList(),
  idempotency: contractText().optional(),
  /** The closed set an outcome takes. */
  values: z
    .array(z.string().min(1).max(WORKFLOW_LIMITS.code))
    .min(1)
    .max(WORKFLOW_LIMITS.values)
    .optional(),
  /** The code of an outside vocabulary a state is (a FHIR status); a preset closes the set. */
  mapsTo: z.string().min(1).max(WORKFLOW_LIMITS.code).optional(),
  channel: z.string().min(1).max(WORKFLOW_LIMITS.label).optional(),
  /** The contracts the step uses, by provider project slug and contract slug (REQ-17 BC-5). */
  contracts: z
    .array(z.strictObject({ provider: slug(), slug: slug() }))
    .min(1)
    .max(WORKFLOW_LIMITS.refs)
    .optional(),
  /** Cross-links: steps of the project's other designs this one is, each held to its type's `links`. */
  refs: z
    .array(
      z.strictObject({ template: z.string().regex(TEMPLATE_ID), flow: slug(), step: stepId() }),
    )
    .min(1)
    .max(WORKFLOW_LIMITS.refs)
    .optional(),
});
export type WorkflowNode = z.infer<typeof nodeSchema>;

// What the code holds (step status, evidence, coverage, drift and the commit read) is never part of a
// design: it is an observation, stored apart (observation-schema.ts), so the plan cannot be overwritten
export const workflowStepV2Schema = z.strictObject({
  id: stepId(),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title).optional(),
  does: z.string().min(1).max(WORKFLOW_LIMITS.does),
  after: z.array(stepId()).max(WORKFLOW_LIMITS.after),
  node: nodeSchema.optional(),
});
export type WorkflowStepV2 = z.infer<typeof workflowStepV2Schema>;

export const edgeSchema = z.strictObject({
  kind: z.string().regex(EDGE_KIND).optional(),
  from: stepId(),
  to: stepId(),
  /** The short business words on the line; absent, its `condition` is shown. */
  label: z.string().min(1).max(WORKFLOW_LIMITS.label).optional(),
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
  /** The data the line carries. */
  payload: textList(WORKFLOW_LIMITS.io),
  /** system-context: what the relationship runs over (HL7v2, FHIR REST, webhook). */
  protocol: z.string().min(1).max(WORKFLOW_LIMITS.protocol).optional(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

const laneSchema = z.strictObject({
  id: z.string().regex(BAND_ID),
  label: z.string().min(1).max(WORKFLOW_LIMITS.label),
  tooltip: z.string().min(1).max(WORKFLOW_LIMITS.purpose).optional(),
});

const workflowV2Fields = {
  $schema: z.literal(WORKFLOW_V2_SCHEMA_ID),
  version: z.literal(2),
  project: uuid(),
  flow: slug(),
  kind: z.enum(WORKFLOW_KINDS),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title),
  summary: z.string().min(1).max(WORKFLOW_LIMITS.summary),
  steps: z.array(workflowStepV2Schema).min(1).max(WORKFLOW_LIMITS.steps),
  /** The diagram template the design is drawn in; it decides the node types, bands and edge kinds. */
  template: templateRefSchema,
  /** The design's own lanes, for a template whose lanes come from the design (actors, systems). */
  lanes: z.array(laneSchema).min(1).max(WORKFLOW_LIMITS.lanes).optional(),
  /** The personas a ux-flow's screens are for. */
  personas: z.array(laneSchema).min(1).max(WORKFLOW_LIMITS.lanes).optional(),
  edges: z.array(edgeSchema).max(WORKFLOW_LIMITS.edges).optional(),
  basedOn: z
    .array(z.strictObject({ workflow: slug(), revision: z.number().int().min(1) }))
    .min(1)
    .max(WORKFLOW_LIMITS.bases)
    .optional(),
  writtenBy: z.strictObject({
    runId: uuid().optional(),
    sessionId: uuid().optional(),
    sha: sha().optional(),
  }),
};

export const workflowWriteV2Schema = z.strictObject(workflowV2Fields);
export type WorkflowWriteV2 = z.infer<typeof workflowWriteV2Schema>;

export const workflowDocumentV2Schema = z.strictObject({ ...workflowV2Fields, ...stamps });

export type WorkflowWrite = WorkflowWriteV2;
export type AnyWorkflowStep = WorkflowStepV2;

export const stepsOf = (doc: WorkflowWrite): readonly AnyWorkflowStep[] => doc.steps;

/** The stored document read back by the version it was written at; never a guess at another. */
export function readStoredWorkflow(raw: unknown): WorkflowWrite | null {
  const parsed = workflowWriteV2Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
