/** What every built-in example is written with: one example project, a design head, and a step. */

import { WORKFLOW_V2_SCHEMA_ID, type WorkflowWriteV2 } from './schema.js';

const EXAMPLE_PROJECT = '00000000-0000-4000-8000-000000000000';

/** The wireframe board attachment every example screen names. */
export const EXAMPLE_BOARD = '00000000-0000-4000-8000-0000000000b0';

export const head = (
  flow: string,
  kind: 'flow' | 'state',
  title: string,
  summary: string,
  id: string,
) => ({
  $schema: WORKFLOW_V2_SCHEMA_ID as WorkflowWriteV2['$schema'],
  version: 2 as const,
  project: EXAMPLE_PROJECT,
  flow,
  kind,
  title,
  summary,
  template: { id, version: 1 },
  writtenBy: {},
});

export const step = (
  id: string,
  does: string,
  after: string[],
  node: NonNullable<WorkflowWriteV2['steps'][number]['node']>,
) => ({ id, does, after, node });

export const ref = (template: string, flow: string, stepId: string) => ({
  template,
  flow,
  step: stepId,
});

export const lane = (id: string, label: string) => ({ id, label });
