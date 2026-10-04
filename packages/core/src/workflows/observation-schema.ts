/**
 * The observed layer of a design (workflow step-health, in-observation): what an agent reading the
 * code at one commit says the code holds, drawn in the design's own node and edge shapes, each node
 * naming the planned step it is, or none. Stored apart from the design and never written into it.
 */

import { repoPath } from '@forge/contracts/repo-path';
import { OBSERVATION_LIMITS } from '@forge/contracts/workflow-health';
import { z } from 'zod';
import { STOREFRONT_PROVIDERS } from '../project-config/index.js';
import {
  COVERAGE_READINGS,
  edgeSchema,
  nodeSchema,
  STEP_ID,
  STOREFRONT_REF_KINDS,
  WORKFLOW_LIMITS,
} from './schema.js';

const SHA = /^[0-9a-f]{40}$/;
const stepId = () => z.string().regex(STEP_ID);

const coverageSchema = z.strictObject({
  reading: z.enum(COVERAGE_READINGS),
  atSha: z.string().regex(SHA).nullable(),
});

// A symbol is optional in the shape so a stored reading migrated from a design document parses; the
// write rule refuses a new citation without one (observation-rules.ts)
const repoCitationSchema = z.strictObject({
  kind: z.literal('repo'),
  file: repoPath(),
  symbol: z.string().min(1).max(WORKFLOW_LIMITS.symbol).optional(),
  coverage: coverageSchema.optional(),
});

const storefrontCitationSchema = z.strictObject({
  kind: z.literal('storefront'),
  provider: z.enum(STOREFRONT_PROVIDERS),
  ref: z.enum(STOREFRONT_REF_KINDS),
  id: z.string().min(1).max(WORKFLOW_LIMITS.ref),
});

export const citationSchema = z.discriminatedUnion('kind', [
  repoCitationSchema,
  storefrontCitationSchema,
]);
export type Citation = z.infer<typeof citationSchema>;

const observedStepSchema = z.strictObject({
  id: stepId(),
  /** The planned step this is, by id, or null for code the design does not hold. */
  matches: stepId().nullable(),
  title: z.string().min(1).max(WORKFLOW_LIMITS.title).optional(),
  does: z.string().min(1).max(WORKFLOW_LIMITS.does),
  after: z.array(stepId()).max(OBSERVATION_LIMITS.after),
  node: nodeSchema.optional(),
  evidence: citationSchema.nullable(),
});

const observedEdgeSchema = edgeSchema.extend({ evidence: citationSchema.nullable() });

const driftSchema = z.strictObject({
  steps: z.array(stepId()).min(1).max(OBSERVATION_LIMITS.steps),
  reason: z.string().min(1).max(WORKFLOW_LIMITS.reason),
});

/** The stored document of an observation, as written and as read back. */
export const observationDocumentSchema = z.strictObject({
  summary: z.string().min(1).max(WORKFLOW_LIMITS.summary).optional(),
  steps: z.array(observedStepSchema).max(OBSERVATION_LIMITS.steps),
  edges: z.array(observedEdgeSchema).max(OBSERVATION_LIMITS.edges),
  /** Steps the code moved under since the commit they were matched at, and why. */
  drift: driftSchema.nullable(),
});
export type ObservationDocument = z.infer<typeof observationDocumentSchema>;

/** `POST /api/projects/:id/workflows/:workflow/observations`. */
export const writeObservationSchema = z.strictObject({
  atSha: z.string().regex(SHA, 'a whole 40-character commit sha'),
  /** The design revision read against; absent, the approved revision, else the latest. */
  revision: z.number().int().min(1).optional(),
  summary: z.string().min(1).max(WORKFLOW_LIMITS.summary).optional(),
  steps: z.array(observedStepSchema).max(OBSERVATION_LIMITS.steps),
  edges: z.array(observedEdgeSchema).max(OBSERVATION_LIMITS.edges).optional(),
  drift: driftSchema.nullable().optional(),
});
export type WriteObservation = z.infer<typeof writeObservationSchema>;

export const WRITE_OBSERVATION_SHAPE =
  '{ atSha, revision?, summary?, steps: [{ id, matches: <planned step id> | null, title?, does, after, node?, evidence: { kind: "repo", file, symbol, coverage? } | { kind: "storefront", provider, ref, id } }], edges?: [{ from, to, kind?, label?, …, evidence }], drift?: { steps, reason } | null }';
