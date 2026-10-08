// The decision a turn's outcome closes its window under, kept apart from the routing that takes the
// turn so the record a continued turn's rest writes later reads it the same way.

import type { RoutedWindow } from './route-window.js';
import type { TurnOutcome } from './turn-request.js';

/**
 * The decision a turn's outcome closes the window under, naming the blocks the turn drew that
 * nobody will see.
 */
export function routedOutcome(outcome: TurnOutcome): RoutedWindow {
  const routed = routedDecision(outcome);
  const continued =
    outcome.kind === 'delivered' && outcome.continuation
      ? { continuation: outcome.continuation }
      : {};
  if (!outcome.droppedBlocks?.length) return { ...routed, ...continued };
  return {
    ...routed,
    ...continued,
    detail: { ...(routed.detail as Record<string, unknown>), droppedBlocks: outcome.droppedBlocks },
  };
}

function routedDecision(outcome: TurnOutcome): RoutedWindow {
  switch (outcome.kind) {
    case 'delivered':
      return {
        decision: 'answered',
        detail: {
          messageId: outcome.messageId,
          ...(outcome.continuation
            ? { continuing: true, continuesUntil: outcome.continuation.until.toISOString() }
            : {}),
        },
      };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    case 'failed':
      return {
        decision: 'unreachable',
        detail: { code: outcome.code, reason: outcome.reason, cause: outcome.cause },
      };
    case 'stopped':
      return { decision: 'stopped', detail: { reason: outcome.reason } };
    case 'diverted':
      return { decision: 'handed-off', detail: { reason: outcome.reason } };
    case 'superseded':
      return { decision: 'undetermined', detail: { reason: outcome.reason, superseded: true } };
    case 'undeliverable':
      return {
        decision: 'undetermined',
        detail: {
          code: outcome.code,
          reason: outcome.reason,
          attempted: true,
          undeliveredReply: outcome.reply,
        },
      };
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}
