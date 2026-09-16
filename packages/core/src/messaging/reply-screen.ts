/**
 * Gather what a door's cell asks for, then screen at that door.
 *
 * A caller names a door and nothing else. The pair the message is read under
 * comes off the door's own row, so there is no second place an audience or an
 * intent can be declared — which is what ISS-997 left open and what a second
 * adapter would otherwise have to get right again on its own (ISS-1002).
 */

import type { Tx } from '../db/client.js';
import type { DoorId, MessageVerdict } from './contract.js';
import { doorCell } from './doors.js';
import type { ProgressFacts } from './facts.js';
import { gatherFacts } from './gather.js';
import { screenMessage } from './screen.js';

export interface ReplyScreenInput {
  readonly projectId: string;
  /** The message as its reader will see it; more than one where it renders as parts. */
  readonly segments: readonly string[];
  readonly toolCalls: readonly {
    name: string;
    arguments: string;
    /** Every issue-shaped reference the whole result named (ISS-1057). */
    resultIssueRefs?: readonly string[];
    /** MCP's own flag on the result; an errored call verifies nothing. */
    isError?: boolean;
  }[];
  /**
   * The snapshot the writer's own turn was shown.
   */
  readonly progress: ProgressFacts | null | 'legacy-session';
  /** A caller inside a transaction MUST pass its own handle. */
  readonly executor?: Tx;
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
    progress: input.progress === 'legacy-session' ? 'compute' : input.progress,
    ...(input.executor ? { executor: input.executor } : {}),
  });
  return screenMessage({ audience, intent, segments: input.segments, facts });
}
