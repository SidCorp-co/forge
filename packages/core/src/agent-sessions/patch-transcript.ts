import { HTTPException } from 'hono/http-exception';
import { toCanonicalMessages } from './canonical-legacy.js';
import { agentSessionsPorts } from './ports.js';
import { recordTurnError } from './session-events.js';
import { deriveChatTurnFinal } from './session-transcript.js';

/** What the handler needs back before it builds its update. */
interface TranscriptPatch {
  /** The `messages` to persist, converted, or undefined where none was sent. */
  messages: Record<string, unknown>[] | undefined;
  /** True when this call derived the turn's transcript from the carrier. */
  derived: boolean;
  snapshot: boolean;
  /** The free-text fields of the PATCH, as they are to be stored. */
  stored: { title?: string | null; metadata?: unknown; diff?: unknown };
}

/**
 * The transcript half of one PATCH: record a reported failure, derive the turn
 * where the carrier holds it, and convert a legacy `messages` array. A failure and a
 * transcript are stored through the same secret scrubber as the session event door.
 */
export async function applyTranscriptPatch(args: {
  sessionId: string;
  isDevice: boolean;
  isTerminal: boolean;
  patch: {
    messages?: unknown[] | undefined;
    toolCallCount?: number | undefined;
    turnError?: string | undefined;
    title?: string | null | undefined;
    metadata?: unknown;
    diff?: unknown;
  };
}): Promise<TranscriptPatch> {
  const { sessionId, isDevice, isTerminal, patch } = args;

  const scrub = <T>(data: T): Promise<T> =>
    agentSessionsPorts().scrubSessionOutput(sessionId, data);

  if (patch.turnError !== undefined && isDevice) {
    await recordTurnError(sessionId, await scrub(patch.turnError));
  }
  const free = { title: patch.title, metadata: patch.metadata, diff: patch.diff };
  const stored = Object.fromEntries(
    Object.entries(free).filter(([, v]) => v !== undefined),
  ) as TranscriptPatch['stored'];
  const scrubbed = Object.keys(stored).length > 0 ? await scrub(stored) : stored;

  const derived =
    isTerminal && isDevice && patch.messages === undefined && patch.toolCallCount === undefined
      ? await deriveChatTurnFinal(sessionId)
      : false;

  if (patch.messages === undefined) {
    return { messages: undefined, derived, snapshot: false, stored: scrubbed };
  }

  const canonical = toCanonicalMessages(patch.messages);
  if (!canonical.ok) {
    throw new HTTPException(400, {
      message: `messages[${canonical.index}] ${canonical.why}`,
      cause: { code: 'UNREPRESENTABLE_ENTRY', details: canonical },
    });
  }
  const snapshot = isTerminal || !isDevice;
  return { messages: await scrub(canonical.messages), derived, snapshot, stored: scrubbed };
}
