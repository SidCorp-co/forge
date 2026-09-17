/**
 * A Forge UI turn, on the socket while it is still running (ISS-1078).
 *
 * The room already learns a finished reply by `conversation.message` and a
 * settled window by `conversation.settled`. Both are doorbells: they carry an
 * id and nothing a caret could be driven from, so a turn that ran six tools
 * over ninety seconds and a turn that hung are the same picture. This is the
 * third event, and it carries the turn itself.
 *
 * What it carries is the canonical `AgentMessage` — the identical shape
 * `lib/agent-stream-parser.ts` builds for a Claude Code CLI transcript and
 * `run-turn.ts` streams over SSE — produced here by the same
 * `createTranscriptAccumulator`. One vocabulary, one formatter, and a future
 * transcript stream rides this channel without a second shape being invented
 * (ISS-1029).
 */

import { randomUUID } from 'node:crypto';
import type { AgentMessage, ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_PROGRESS_EVENT,
} from './conversation-adapter.js';
import type { ChatStreamEvent } from './providers/types.js';
import { createTranscriptAccumulator, ENTRY_FLUSH_MS } from './transcript-entry.js';

/**
 * Prose reaches the room BEFORE the reply screen has judged it.
 */
// cm:hack ISS-1078 until:an incremental reply screen exists that can judge a partial message — until then prose reaches the room unjudged, and the correction frame below is what pays for it
// cm:guard the amnesty is on the SOCKET and never on the RECORD, and that boundary is what bounds
// it: `transcript.ts:recordDeliveredReply` still writes only the text that went out, and
// `onSettled` below drops the streamed text blocks outright where the screen replaced the reply, so
// a refused draft reaches no durable row through `content` or through `blocks`.
// cm:guard ISS-978's rule — no branch may send model prose under a verdict that did not read that
// exact string — is REVERSED here and here alone, by the owner's call of 2026-09-17: the collision
// is that `screenReplyAtDoor` judges a whole message after the turn completes, so there is no
// incremental screen to run and live prose is necessarily unscreened prose. The price is that a
// reader can see a sentence the door then refuses. What pays it is `onSettled`: the replacement is
// published marked as a correction rather than swapped in silently, so the reader is told the text
// they saw was withdrawn. When an incremental screen lands, prose is screened as it streams and the
// correction marker becomes dead code — that is the condition this hack ends on.
const AMNESTY = 'the reply screen judges a whole message, so streamed prose is unjudged prose';

/** What a turn hands back once its text has settled, for the row it becomes. */
export interface SettledEntry {
  /**
   * The id every frame of this turn carried, so the row and the frames are ONE turn.
   */
  // cm:guard minted once, HERE, and carried into the durable row through `AppendMessageArgs.id`:
  // letting the column mint its own gave the growing frames one identity and the settled row
  // another, and a client keyed by `id` saw two assistant turns for one answer (ISS-1029 review F1,
  // confirmed on beta).
  entryId: string;
  /** The ordered blocks to store, or null where there are none to keep. */
  blocks: ContentBlock[] | null;
}

export interface ConversationProgressHandle {
  /** Fold one loop event into the entry and, on the window, publish it. */
  onTurnEvent: (event: ChatStreamEvent) => void;
  /** The screen has settled on this exact text; publish any correction and say what to store. */
  onSettled: (deliveredText: string) => Promise<SettledEntry>;
}

/** The turn's last text block — what the model finally said, as the socket carried it. */
// cm:guard the LAST text block and never the accumulated `content`: `content` is every text block
// joined, so on a turn that talked before calling a tool it holds commentary the delivered text
// never had — and comparing THAT against the delivered string would mark every tool-using turn a
// correction. The delivered text is the round that requested no tools, which is this block.
function finalProse(entry: AgentMessage | null): string | null {
  const blocks = entry?.blocks;
  if (!blocks) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === 'text') return block.text ?? '';
  }
  return null;
}

/** The same blocks with every text block dropped. */
// cm:guard what survives a REPLACEMENT is the tool record and nothing else: the text blocks hold the
// draft the door refused, so storing them verbatim beside the replacement would put that draft into
// the permanent record through `blocks` — the exact boundary the amnesty above is bounded by. The
// interleaving of a reply nobody streamed is not known, and inventing one would be a fabrication, so
// the delivered sentence lives in `content` alone and the blocks say only what the turn ran.
function toolBlocksOnly(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type !== 'text');
}

/**
 * Start streaming one Forge UI turn into its room.
 */
// cm:guard every frame goes out through `publishToConversationReaders`, which runs
// `assertConversationReadable` per participant — the SAME check a delivery makes, per frame, and not
// a reader set resolved once and reused: a participant row is not a permission, somebody who lost
// project access keeps their row, and a frame that reached them would hand over the text of a room
// the reads refuse them. The per-frame cost is what the coalescing window exists to bound
// (ISS-1004 step 5 review F1, ISS-1078 criterion 14).
export function startConversationProgress(args: {
  conversationId: string;
  entryId?: string;
  now?: () => number;
  /** Test seam; production publishes to the room's own readers. */
  publish?: (envelope: { event: string; data: unknown }) => Promise<unknown>;
}): ConversationProgressHandle {
  const now = args.now ?? (() => Date.now());
  const entryId = args.entryId ?? randomUUID();
  const acc = createTranscriptAccumulator({ id: entryId, now });
  const publish =
    args.publish ??
    ((envelope: { event: string; data: unknown }) =>
      publishToConversationReaders(args.conversationId, envelope));

  let lastFlush = 0;
  let published = false;
  // cm:guard the frames are CHAINED rather than each fired independently: a flush resolves the
  // room's readers before it reaches a socket, and two overlapping resolutions can put a later
  // entry on the wire in front of an earlier one — which on this wire means the caret jumping
  // backwards. The chain is per turn, so one room's frames never wait on another's.
  let chain: Promise<unknown> = Promise.resolve();

  // cm:guard a publish failure is SWALLOWED, and it is swallowed here, around the publish alone:
  // zero open sockets is not a failed turn — `conversation-adapter.ts` already states this for
  // delivery and it holds the harder for a best-effort view of one. What is NOT swallowed is the
  // accumulator's own refusal, which `onTurnEvent` lets through so the turn ends on it.
  const send = (entry: AgentMessage, replaced?: true): void => {
    published = true;
    chain = chain.then(() =>
      publish({
        event: WEB_CONVERSATION_PROGRESS_EVENT,
        data: {
          conversationId: args.conversationId,
          entry,
          ...(replaced ? { replaced: true, amnesty: AMNESTY } : {}),
        },
      }).catch((err: unknown) =>
        logger.warn(
          { err, conversationId: args.conversationId },
          'web conversations: a progress frame was not published',
        ),
      ),
    );
  };

  return {
    onTurnEvent(event: ChatStreamEvent): void {
      acc.apply(event);
      // cm:guard a tool call and a tool result flush IMMEDIATELY and never wait out the window:
      // those are the two frames a reader is actually waiting on — the card appearing, the result
      // landing on it — and there are few of them, so the window buys nothing by holding them.
      const settling = event.type === 'tool_call' || event.type === 'tool_result';
      const at = now();
      if (!settling && at - lastFlush < ENTRY_FLUSH_MS) return;
      const entry = acc.entry();
      if (!entry) return;
      lastFlush = at;
      send(entry);
    },

    async onSettled(deliveredText: string): Promise<SettledEntry> {
      const entry = acc.entry();
      const streamed = finalProse(entry);
      // cm:guard a turn that published NOTHING has nothing to correct, whatever it delivers: an
      // Agent-mode divert and a room answered by a code-authored line never streamed a word, and
      // marking their reply a correction would tell a reader text was withdrawn that they never saw.
      const replaced = published && streamed !== null && streamed !== deliveredText;
      if (replaced && entry) {
        // cm:guard the replacement is published as its OWN final frame carrying the delivered text,
        // marked, rather than the draft being edited away: swapping it in place is the silent
        // substitution the owner's decision refuses — a reader who read the draft is owed the fact
        // that it was withdrawn, not a screen that quietly disagrees with what they remember.
        send(
          {
            ...entry,
            blocks: [...toolBlocksOnly(entry.blocks ?? []), { type: 'text', text: deliveredText }],
            content: deliveredText,
          },
          true,
        );
      }
      await chain;
      const blocks = replaced && entry ? toolBlocksOnly(entry.blocks ?? []) : (acc.blocks() ?? []);
      return { entryId, blocks: blocks.length > 0 ? blocks : null };
    },
  };
}
