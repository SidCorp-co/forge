/**
 * Fetch the images a Rocket.Chat message carries, for the two consumers that
 * need the bytes: the model (as content parts) and any issue the bot files
 * this turn (as attachments).
 *
 * Downloading happens HERE, at the edge that owns the bot credential, and the
 * credential never travels further — neither consumer is given a URL it would
 * have to authenticate.
 */

import { buildEscalationToolset } from '../../assistant/tools/escalate.js';
import { type ChatToolset, mergeToolsets } from '../../assistant/tools/mcp-adapter.js';
import { buildChatToolContext } from '../../assistant/tools/principal.js';
import { buildProjectToolset } from '../../assistant/tools/registry.js';
import { withTurnImages } from '../../assistant/tools/turn-images.js';
import type { ImageResolver, TurnImage } from '../../assistant/vision.js';
import { buildTranscriptSearchToolset } from '../../conversations/transcript-search-tool.js';
import { logger } from '../../logger.js';
import type { ChatTurnFacts } from '../../mcp/tools/lib.js';
import { buildRocketChatHistoryToolset, buildRocketChatQuoteContextToolset } from './context.js';
import {
  buildMessagePermalink,
  fetchAttachmentBytes,
  type RocketChatImageRef,
  type RocketChatRestAuth,
} from './rest-client.js';

/**
 * Per-message ceiling. A room can attach a dozen files to one post; the model
 * gains nothing from the tail, and each one costs a download plus its share of
 * the vision budget.
 */
export const MAX_INBOUND_IMAGES = 4;

/**
 * Per-image ceiling, checked against `content-length` before any body is read.
 * Roughly a 4K screenshot at PNG density; above it the upload is a photo or a
 * capture nobody meant to discuss, and `VISION_BUDGET_BYTES` would spend the
 * whole request on it.
 */
export const MAX_IMAGE_BYTES = 4_000_000;

async function download(
  auth: RocketChatRestAuth,
  ref: RocketChatImageRef,
): Promise<TurnImage | null> {
  const bytes = await fetchAttachmentBytes(auth, ref.ref, MAX_IMAGE_BYTES);
  if (!bytes) {
    logger.warn({ ref: ref.ref, mime: ref.mime }, 'rocketchat: image download failed or too large');
    return null;
  }
  return { name: ref.name, mime: ref.mime, ref: ref.ref, dataBase64: bytes.toString('base64') };
}

/** Download a message's images; a failure drops that image, never the turn. */
export async function downloadTurnImages(
  auth: RocketChatRestAuth,
  refs: readonly RocketChatImageRef[],
): Promise<TurnImage[]> {
  if (refs.length === 0) return [];
  const settled = await Promise.all(
    refs.slice(0, MAX_INBOUND_IMAGES).map((r) => download(auth, r)),
  );
  return settled.filter((i): i is TurnImage => i !== null);
}

/**
 * Re-fetch an image from an EARLIER turn that is still inside the vision
 * lookback — the room asks three questions about one screenshot, and only the
 * first of them carries it.
 */
export function makeImageResolver(auth: RocketChatRestAuth): ImageResolver {
  return async (image) => {
    const bytes = await fetchAttachmentBytes(auth, image.ref, MAX_IMAGE_BYTES);
    return bytes ? bytes.toString('base64') : null;
  };
}

/**
 * Everything a fast-path turn needs from the room's uploads: the images
 * themselves, a resolver for the ones on earlier turns, and the toolset —
 * `forge_*`, the room-scoped history reader, escalation, the project's
 * external MCP hubs — wrapped so an issue filed this turn is filed with them.
 */
export interface FastTurnInputs {
  tools: ChatToolset;
  images: TurnImage[];
  resolveImage: ImageResolver;
}

// cm:guard the principal is the TURN's and never the route's: a direct room's turn runs as the person who spoke (ISS-987), and the route carries the organization's creator, so reading `opts.route.principalUserId` here again would quietly restore the creator for every DM. The field is off the route shape for that reason rather than merely unused.
export async function prepareFastTurn(opts: {
  route: { projectId: string; projectSlug: string };
  principalUserId: string;
  /** The room and its linked speaker, for the tools that write on the speaker's behalf (ISS-1034). */
  turn: ChatTurnFacts;
  restAuth: RocketChatRestAuth;
  rid: string;
  /** The thread this venue is, where it is one; a thread is its own conversation (ISS-1090). */
  tmid?: string | undefined;
  images: readonly RocketChatImageRef[];
  externalToolsets: ChatToolset[];
}): Promise<FastTurnInputs> {
  const images = await downloadTurnImages(opts.restAuth, opts.images);
  const ctx = buildChatToolContext({
    userId: opts.principalUserId,
    projectId: opts.route.projectId,
    projectSlug: opts.route.projectSlug,
    turn: opts.turn,
  });
  return {
    images,
    resolveImage: makeImageResolver(opts.restAuth),
    tools: withTurnImages(
      mergeToolsets(
        buildProjectToolset(ctx),
        buildRocketChatHistoryToolset(opts.restAuth, opts.rid),
        buildRocketChatQuoteContextToolset(opts.restAuth, opts.rid),
        ...transcriptSearchToolsets(opts),
        buildEscalationToolset(),
        ...opts.externalToolsets,
      ),
      images,
    ),
  };
}

/**
 * The room's own past, where this turn has a room to ask about.
 */
// cm:guard attached only where the turn NAMES a conversation, and never as a tool that always refuses: a turn with no conversation row is a path that does not collect a transcript, so a tool offered there would spend the model's attention on a room that does not exist.
// cm:guard a THREAD is told apart and said so: `conversation-port.ts:rocketChatVenueId` gives a thread its own `external_id`, so this conversation holds the thread and not the channel around it. The alternative — searching the parent room too — answers under a second room's scope, which is the widening ISS-1090 rule 1 forbids, so the turn is told what it cannot reach rather than quietly given less than it asked for.
function transcriptSearchToolsets(opts: {
  principalUserId: string;
  turn: ChatTurnFacts;
  restAuth: RocketChatRestAuth;
  rid: string;
  tmid?: string | undefined;
}): ChatToolset[] {
  const conversationId = opts.turn.conversationId;
  if (!conversationId) return [];
  return [
    buildTranscriptSearchToolset({
      conversationId,
      principalUserId: opts.principalUserId,
      permalink: (externalId) => buildMessagePermalink(opts.restAuth, opts.rid, externalId),
      ...(opts.tmid
        ? {
            venueLimitation:
              'this search covers only the thread this message is in; messages posted in the surrounding channel are a different conversation and are not in it',
          }
        : {}),
    }),
  ];
}
