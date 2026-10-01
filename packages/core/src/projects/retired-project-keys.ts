import type { z } from 'zod';
import { RETIRED_STATE_CONTEXT_MESSAGE } from './agent-config.js';
import { refuseAgentConfigRecord } from './agent-config-schema.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

/** The refusal for a key a strict project body does not declare: named, never stripped to a 200. */
export function undeclaredFieldError(door: string, fields: readonly string[]) {
  return (issue: { code?: string; keys?: readonly string[] }) => {
    if (issue.code !== 'unrecognized_keys' || !issue.keys) return undefined;
    const named = issue.keys.map((k) => `\`${k}\``).join(', ');
    return `${named} ${issue.keys.length === 1 ? 'is not a field' : 'are not fields'} of ${door}, so nothing would read ${issue.keys.length === 1 ? 'it' : 'them'}: refused rather than answered 200 and dropped. The fields are ${fields.join(', ')}.`;
  };
}

export function refuseRetiredProjectKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  const retired = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const body = raw as { stateContext?: unknown; agentConfig?: unknown };
  if ('stateContext' in body) retired(['stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  if (!('agentConfig' in body)) return;
  const ac = body.agentConfig as Record<string, unknown> | null | undefined;
  if (!ac || typeof ac !== 'object') {
    refuseAgentConfigRecord(ac, ctx);
    return;
  }
  if ('stateContext' in ac) retired(['agentConfig', 'stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  if ('projectFacts' in ac) retired(['agentConfig', 'projectFacts'], RETIRED_PROJECT_FACTS_MESSAGE);
  if ('projectFactsConfig' in ac) {
    retired(['agentConfig', 'projectFactsConfig'], RETIRED_PROJECT_FACTS_CONFIG_MESSAGE);
  }
  refuseAgentConfigRecord(ac, ctx, ['agentConfig'], NAMED_ABOVE);
}

/** The three keys whose retirement message is added above, so the record walk does not repeat them. */
const NAMED_ABOVE: ReadonlySet<string> = new Set([
  'stateContext',
  'projectFacts',
  'projectFactsConfig',
]);
