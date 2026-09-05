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

// cm:guard fork on `drive`, and `jobType` is a sound proxy for the lane because `autonomousStepFor` is the ONLY producer of that type and `POST /api/issues/:id/run-pipeline-step` takes no stage at all — a drive job cannot be enqueued outside the autonomous lane. What reached a driver before this fork was not a stale tool name: it was a nine-rung ladder this mode does not have, and instructions to park at `waiting`, `reopen` and `on_hold` — the three `issues/autonomous-park.ts` rewrites at write time, so the prompt instructed the exact move a net exists to catch. That is wrong on ANY transport, which is the reason for the fork; the driver's MCP client works and is not the argument.
// cm:guard the staged branch must return the module constants BYTE-IDENTICALLY. These two blocks are the head of the shared prefix every staged job sends, so anything computed per-call here — a trim, a join, an interpolated project name — turns a broad Anthropic prompt-cache hit into a miss on every staged dispatch.
export function mandatoryPreambleBlocks(step: JobType | null): {
  pipelineRules: string;
  toolReference: string;
} {
  return step === 'drive'
    ? { pipelineRules: DRIVE_RULES_TEXT, toolReference: DRIVE_TOOL_REFERENCE_TEXT }
    : { pipelineRules: PIPELINE_RULES, toolReference: TOOL_REFERENCE };
}
