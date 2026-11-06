// A decision whose act was refused twice in a conversation is not offered there a third time (REQ-41
// BC-28; ISS-624, judge K66 on dev.304: a twice-refused Open on a draft was drawn again on the next
// `forge_needs_you` read). The chat's read of what waits on the person leaves it out of `decisions`,
// so no card is drawn for it and the model cannot recommend it, and names it under `withheld` with
// both refusals and the Forge feedback item recording them, for the model to say so.

import {
  type NeedsYouDecisions,
  needsYouDecisionsSchema,
} from '@forge/contracts/needs-you-decisions';
import type { CallToolResult } from '../../lib/tool-result.js';
import { decisionsRefusedTwice, refusedTwiceWhy } from '../decision-acts.js';
import type { ChatToolset } from './mcp-adapter.js';

/** The read the person's Needs-you list draws, as the chat calls it. */
export const NEEDS_YOU_READ = 'forge_needs_you';

/** The read with every decision refused twice in the conversation left out and named withheld. */
export async function withoutRefusedTwice(
  read: NeedsYouDecisions,
  conversationId: string,
): Promise<NeedsYouDecisions> {
  const twice = await decisionsRefusedTwice(conversationId);
  if (twice.size === 0) return read;
  const left = read.decisions.filter((d) => !twice.has(d.id));
  const withheld = read.decisions.flatMap((d) => {
    const refusals = twice.get(d.id);
    return refusals ? [{ decision: d.id, key: d.key, why: refusedTwiceWhy(d.key, refusals) }] : [];
  });
  if (withheld.length === 0) return read;
  return {
    ...read,
    decisions: left,
    total: read.total - withheld.length,
    withheld: [...(read.withheld ?? []), ...withheld],
  };
}

function textOf(result: CallToolResult): string | null {
  const [first] = result.content;
  return result.content.length === 1 && first?.type === 'text' ? first.text : null;
}

/** `set`, its needs-you read answered without the decisions refused twice in `conversationId`. */
export function withholdingRefusedTwice(set: ChatToolset, conversationId: string): ChatToolset {
  return {
    ...set,
    async execute(name, argsJson) {
      const result = await set.execute(name, argsJson);
      if (name !== NEEDS_YOU_READ || result.isError) return result;
      // the read is core's own: one not in its contract's shape is core's defect, said loudly, never
      // passed on with a twice-refused decision still in it
      const text = textOf(result);
      const parsed = needsYouDecisionsSchema.safeParse(text === null ? null : JSON.parse(text));
      if (!parsed.success) {
        throw new Error(
          `${NEEDS_YOU_READ} answered outside its contract (${parsed.error.issues[0]?.message ?? 'not one text block'}), so the decisions refused twice in conversation ${conversationId} could not be withheld`,
        );
      }
      const read = await withoutRefusedTwice(parsed.data, conversationId);
      return read === parsed.data
        ? result
        : {
            ...result,
            content: [{ type: 'text', text: JSON.stringify(read) }],
            structuredContent: read,
          };
    },
  };
}
