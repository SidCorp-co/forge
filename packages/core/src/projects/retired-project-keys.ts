import type { z } from 'zod';
import { refuseRetiredStageKeys } from '../pipeline/pipeline-config-schema.js';
import { RETIRED_STATE_CONTEXT_MESSAGE } from './agent-config.js';
import { refuseAgentConfigRecord } from './agent-config-schema.js';
import { ENVIRONMENTS_MOVED_MESSAGE, RETIRED_PREVIEW_DEPLOY_MESSAGE } from './environments.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

export function refuseRetiredProjectKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  const retired = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const body = raw as { stateContext?: unknown; agentConfig?: unknown; environments?: unknown };
  if ('stateContext' in body) retired(['stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  if ('previewDeploy' in body) retired(['previewDeploy'], RETIRED_PREVIEW_DEPLOY_MESSAGE);
  if ('environments' in body) retired(['environments'], ENVIRONMENTS_MOVED_MESSAGE);
  if (!('agentConfig' in body)) return;
  const ac = body.agentConfig as { pipelineConfig?: unknown } | null | undefined;
  if (!ac || typeof ac !== 'object') {
    refuseAgentConfigRecord(ac, ctx);
    return;
  }
  if ('stateContext' in ac) retired(['agentConfig', 'stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
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
