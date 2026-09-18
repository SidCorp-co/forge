import type { z } from 'zod';
import { refuseRetiredStageKeys } from '../pipeline/pipeline-config-schema.js';
import { RETIRED_STATE_CONTEXT_MESSAGE } from './agent-config.js';
import { refuseAgentConfigRecord } from './agent-config-schema.js';
import { RETIRED_PREVIEW_DEPLOY_MESSAGE } from './environments.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

/**
 * The retired keys of `PATCH /api/projects/:id`, refused on the RAW body before
 * `updateProjectSchema` strips them.
 *
 * That object drops an unknown key silently, so deleting `stateContext` from it would
 * answer the operator's save with a 200 and no write, which is the same defect the retirement
 * removes (ISS-1000). Every retirement since has been refused here for that one reason.
 *
 * ISS-1070 — `agentConfig` is no longer a field on this route. It was
 * `z.record(z.string(), z.unknown())` assigned straight onto the column, which made it a door past
 * every refusal `pipelineConfigPatchSchema` makes; it is refused whole here, one message per key
 * naming that key's own door, so a caller learns what to send instead rather than which field to
 * drop. The prose keys, the stage keys and `stateContext` keep their own messages inside it,
 * because a caller still sending one of those is asking a question the door alone does not answer.
 */
// cm:guard the walk refuses `agentConfig` ENTIRELY and per key. It used to refuse only the retired keys inside it, to keep an escape hatch four settings surfaces wrote through — the hatch closed in ISS-1070 because `systemPrompt` and `categories`, the two values that had no named field, got one first. A key added to `agentConfigSchema` with no door reopens it: give the key a field here in the same change, or `agent-config-doors.test.ts` goes red.
// cm:edge contract -> packages/core/src/projects/agent-config-schema.ts — that file's declared key set and door table decide every message this walk produces for an `agentConfig` record
export function refuseRetiredProjectKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  const retired = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const body = raw as { stateContext?: unknown; agentConfig?: unknown };
  if ('stateContext' in body) retired(['stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  // cm:why ISS-1069 — `previewDeploy` became `environments`, refused here by name for the reason `stateContext` is: `updateProjectSchema` strips an undeclared key silently, which answers an operator's save with a 200 and no write
  if ('previewDeploy' in body) retired(['previewDeploy'], RETIRED_PREVIEW_DEPLOY_MESSAGE);
  if (!('agentConfig' in body)) return;
  const ac = body.agentConfig as { pipelineConfig?: unknown } | null | undefined;
  if (!ac || typeof ac !== 'object') {
    refuseAgentConfigRecord(ac, ctx);
    return;
  }
  if ('stateContext' in ac) retired(['agentConfig', 'stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  // cm:why ISS-1048 — the prose keys left the column for `knowledge_entries`, named here so a caller who still holds the old shape is told where the prose went rather than which field to remove
  if ('projectFacts' in ac) retired(['agentConfig', 'projectFacts'], RETIRED_PROJECT_FACTS_MESSAGE);
  if ('projectFactsConfig' in ac) {
    retired(['agentConfig', 'projectFactsConfig'], RETIRED_PROJECT_FACTS_CONFIG_MESSAGE);
  }
  const states = (ac.pipelineConfig as { states?: unknown } | null | undefined)?.states;
  refuseRetiredStageKeys(states, ctx, ['agentConfig', 'pipelineConfig', 'states']);
  refuseAgentConfigRecord(ac, ctx, ['agentConfig'], NAMED_ABOVE);
}

/** The three keys whose retirement message is added above, so the record walk does not repeat them. */
const NAMED_ABOVE: ReadonlySet<string> = new Set([
  'stateContext',
  'projectFacts',
  'projectFactsConfig',
]);
