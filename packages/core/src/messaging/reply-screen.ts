import type { Tx } from '../db/client.js';
import type { DoorId, MessageVerdict } from './contract.js';
import { doorCell } from './doors.js';
import type { ProgressFacts } from './facts.js';
import { gatherFacts } from './gather.js';
import { withGrounding } from './grounding-rule.js';
import { screenMessage } from './screen.js';

interface ReplyScreenInput {
  readonly projectId: string;
  /** The message as its reader will see it; more than one where it renders as parts. */
  readonly segments: readonly string[];
  readonly toolCalls: readonly {
    name: string;
    arguments: string;
    isError?: boolean;
  }[];
  /** The tools the writer's turn was offered; a rule holding a claim to a read judges only where one was. */
  readonly offeredTools?: readonly string[];
  /**
   * The snapshot the writer's own turn was shown.
   */
  readonly progress: ProgressFacts | null;
  /** A caller inside a transaction MUST pass its own handle. */
  readonly executor?: Tx;
  /**
   * What the writer's own turn read, where the caller has it: a date or status the reply states
   * about the tracker is then held to these (`grounding-rule.ts`).
   */
  readonly toolResults?: readonly string[];
}

export async function screenReplyAtDoor(
  door: DoorId,
  input: ReplyScreenInput,
): Promise<MessageVerdict> {
  const { audience, intent } = doorCell(door);
  const facts = await gatherFacts({
    projectId: input.projectId,
    audience,
    intent,
    segments: input.segments,
    toolCalls: input.toolCalls,
    ...(input.offeredTools ? { offeredTools: input.offeredTools } : {}),
    progress: input.progress,
    ...(input.executor ? { executor: input.executor } : {}),
  });
  const verdict = screenMessage({ audience, intent, segments: input.segments, facts });
  return input.toolResults
    ? withGrounding(verdict, input.segments, input.toolResults, facts)
    : verdict;
}
