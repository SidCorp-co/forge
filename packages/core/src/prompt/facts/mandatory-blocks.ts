// The two blocks injected into EVERY job rather than fetched on demand, and
// the lane fork between them. Everything else a job is told is either
// per-project (`resolve.ts`), per-stage (`appliesTo`) or fetched by the agent.
//
// Lives apart from `system.ts` because that module imports the DB client:
// the fork is a pure string choice and a unit test of it should not need a
// database, an env file, or a mock of either.

import type { JobType } from '../../db/schema.js';
import { DRIVE_RULES_TEXT, DRIVE_TOOL_REFERENCE_TEXT } from './drive-rules.js';
import { renderFact } from './registry.js';

export const PIPELINE_RULES = renderFact('pipeline-rules') ?? '';

export const TOOL_REFERENCE = renderFact('mcp-tool-reference') ?? '';

export function mandatoryPreambleBlocks(step: JobType | null): {
  pipelineRules: string;
  toolReference: string;
} {
  return step === 'drive'
    ? { pipelineRules: DRIVE_RULES_TEXT, toolReference: DRIVE_TOOL_REFERENCE_TEXT }
    : { pipelineRules: PIPELINE_RULES, toolReference: TOOL_REFERENCE };
}
