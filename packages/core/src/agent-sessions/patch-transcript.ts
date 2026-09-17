/**
 * ISS-1030 — what `PATCH /api/agent-sessions/:id` owes the transcript, in one
 * place.
 *
 * Three things landed on that handler together and they answer to one question
 * — who is writing this turn's record, this release's daemon or the previous
 * one — so they are read side by side rather than three conditions apart in a
 * 350-line route.
 */
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
  /**
   * True when this wholesale write must be recorded in the carrier as well.
   *
   * cm:guard the carrier has to stay a complete account of the session, and a
   * `messages` array written past it is the one thing that can make it
   * incomplete. The row is written by the handler INSIDE its own transaction,
   * beside the update it records, so a carrier claiming a transcript the session
   * does not hold is not a state this pair can leave behind.
   */
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

  // cm:guard the error a failed turn reports becomes a transcript entry HERE,
  // written into the carrier so the fold puts it in its place in the
  // conversation. It goes in before the derive, which is what makes it appear on
  // the transcript this PATCH persists rather than on the next one.
  if (patch.turnError !== undefined && isDevice) {
    await recordTurnError(sessionId, patch.turnError);
  }

  // cm:guard the gate is "this terminal patch carries NOTHING only a daemon on
  // the previous release sends", and it is the whole compatibility story in one
  // condition. That daemon reports its own transcript in `messages` and its own
  // tool count in `toolCallCount`; a daemon on this release sends neither,
  // because its lines went to the carrier and the transcript can count for
  // itself. Widening this to every terminal patch would derive over a session
  // whose carrier holds prompts alone and replace that daemon's transcript with
  // the questions and none of the answers.
  // cm:guard it runs BEFORE the handler's write, because the blind-schedule rule
  // reads how many tools this run called off the transcript, and a transcript as
  // of the last throttled flush is missing the tail of the turn.
  // cm:edge lockstep -> packages/core/src/jobs/session-transcript.ts — the chat
  // path's counterpart of `deriveSessionFinal`, which the pipeline path fires
  // from `jobs/lifecycle-routes.ts` on job terminal.
  const derived =
    isTerminal && isDevice && patch.messages === undefined && patch.toolCallCount === undefined
      ? await deriveChatTurnFinal(sessionId)
      : false;

  // cm:hack ISS-1030 until: no device below the runner release carrying the
  // raw-line route has reported in 30 days, read off `devices.version` and
  // `devices.lastSeenAt` — then this branch and `messages` on `patchSchema` go,
  // and a PATCH carrying `messages` is refused outright.
  // cm:guard the price of the amnesty is that it CONVERTS rather than records.
  // Recording what an un-upgraded daemon sends is what would break the whole
  // change: the backfill runs, both readers lose their `role` branch, and the
  // next PATCH from an old box writes legacy entries that nothing left in the
  // product can read — one criterion green while three go red. The converter is
  // the same one the migration calls, on purpose; a second set of rules here is
  // the divergence this issue exists to end.
  // cm:edge lockstep -> packages/core/src/agent-sessions/canonical-legacy.ts
  if (patch.messages === undefined) return { messages: undefined, derived, snapshot: false };
  const canonical = toCanonicalMessages(patch.messages);
  if (!canonical.ok) {
    throw new HTTPException(400, {
      message: `messages[${canonical.index}] ${canonical.why}`,
      cause: { code: 'UNREPRESENTABLE_ENTRY', details: canonical },
    });
  }
  // cm:guard an interim flush from a daemon on the previous release is NOT
  // recorded: it PATCHes its whole array on every throttled write, and its own
  // terminal patch carries everything those held. A write by a person — an
  // edited turn — is recorded whenever it lands, because nothing supersedes it.
  const snapshot = isTerminal || !isDevice;
  return { messages: canonical.messages, derived, snapshot };
}
