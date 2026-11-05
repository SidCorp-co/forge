// The `plain` argument every Assistant tool that may be held takes (ISS-1006): the line a person
// decides the proposal from, written by the turn that proposes it. It is the card's, never the
// write's: it is taken off the call before the rule reads it, the card is held, or the tool runs, so
// the write the person agrees to is the call as it would have been without it.

import { PLAIN_DECISION_MAX, PLAIN_DECISION_RULE } from '@forge/contracts/plain-decision';
import type { ChatTool } from '../../integrations/llm/index.js';

/** The tools a held write is made through (`summary.ts:kindOfToolCall`): each takes `plain`. */
export const PLAIN_TOOLS: ReadonlySet<string> = new Set([
  'project_feedback',
  'forge_requirement_draft',
  'forge_requirement_revise',
  'forge_memory_note',
  'forge_preferences',
  'forge_template_save',
  'forge',
]);

const PLAIN_PARAM = {
  type: 'string',
  maxLength: PLAIN_DECISION_MAX,
  description: `Where this call writes a record, the line the person decides it from on its card: ${PLAIN_DECISION_RULE}. Never part of what is written.`,
} as const;

/** The tools as offered to the model, each that may be held taking `plain`. */
export function withPlainParam(tools: readonly ChatTool[]): ChatTool[] {
  return tools.map((tool) => {
    const params = tool.function.parameters;
    const properties = params.properties as Record<string, unknown> | undefined;
    if (!PLAIN_TOOLS.has(tool.function.name) || !properties || 'plain' in properties) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: { ...params, properties: { ...properties, plain: PLAIN_PARAM } },
      },
    };
  });
}

/**
 * The call without its `plain`, and the line it carried: null where it sent none or an empty one, the
 * call as written where its tool takes none or its arguments do not parse.
 */
export function splitPlain(
  name: string,
  argsJson: string,
): { argsJson: string; plain: string | null } {
  if (!PLAIN_TOOLS.has(name)) return { argsJson, plain: null };
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return { argsJson, plain: null };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args) || !('plain' in args)) {
    return { argsJson, plain: null };
  }
  const { plain, ...rest } = args as Record<string, unknown>;
  const text = typeof plain === 'string' ? plain.trim() : '';
  return { argsJson: JSON.stringify(rest), plain: text ? text.slice(0, PLAIN_DECISION_MAX) : null };
}
