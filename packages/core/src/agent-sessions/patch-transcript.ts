import { HTTPException } from 'hono/http-exception';
import { deriveChatTurnFinal } from '../jobs/session-transcript.js';
import { toCanonicalMessages } from './canonical-legacy.js';
import { recordTurnError } from './session-events.js';

/** What the handler needs back before it builds its update. */
export interface TranscriptPatch {
  /** The `messages` to persist, converted, or undefined where none was sent. */
  messages: Record<string, unknown>[] | undefined;
  /** True when this call derived the turn's transcript from the carrier. */
  derived: boolean;
  snapshot: boolean;
}

/**
 * The transcript half of one PATCH: record a reported failure, derive the turn
 * where the carrier holds it, and convert a legacy `messages` array.
 */
export async function applyTranscriptPatch(args: {
  sessionId: string;
  isDevice: boolean;
  isTerminal: boolean;
  patch: {
    messages?: unknown[] | undefined;
    toolCallCount?: number | undefined;
    turnError?: string | undefined;
  };
}): Promise<TranscriptPatch> {
  const { sessionId, isDevice, isTerminal, patch } = args;

  if (patch.turnError !== undefined && isDevice) {
    await recordTurnError(sessionId, patch.turnError);
  }

  const derived =
    isTerminal && isDevice && patch.messages === undefined && patch.toolCallCount === undefined
      ? await deriveChatTurnFinal(sessionId)
      : false;

  if (patch.messages === undefined) return { messages: undefined, derived, snapshot: false };

  const canonical = toCanonicalMessages(patch.messages);
  if (!canonical.ok) {
    throw new HTTPException(400, {
      message: `messages[${canonical.index}] ${canonical.why}`,
      cause: { code: 'UNREPRESENTABLE_ENTRY', details: canonical },
    });
  }
  const snapshot = isTerminal || !isDevice;
  return { messages: canonical.messages, derived, snapshot };
}
