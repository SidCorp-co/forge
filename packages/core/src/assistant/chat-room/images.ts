import type { TurnCredential } from '../../credentials/turn-credential.js';
import {
  buildMessagePermalink,
  fetchAttachmentBytes,
  ROCKETCHAT_IMAGE_CAPS,
  type RocketChatImageRef,
  type RocketChatRestAuth,
} from '../../integrations/rocketchat/index.js';
import { logger } from '../../lib/logger.js';
import type { ChatTurnFacts } from '../../lib/tool.js';
import { buildEscalationToolset } from '../tools/escalate.js';
import { type ChatToolset, mergeToolsets } from '../tools/mcp-adapter.js';
import { buildChatToolContext } from '../tools/principal.js';
import { buildProjectToolset } from '../tools/registry.js';
import { buildTranscriptSearchToolset } from '../tools/transcript-search-tool.js';
import { withTurnImages } from '../tools/turn-images.js';
import type { ImageResolver, TurnImage } from '../vision.js';
import { buildRocketChatHistoryToolset, buildRocketChatQuoteContextToolset } from './context.js';

/** Per-message ceilings, the ones a support room's session reads under too (ISS-1010). */
const MAX_INBOUND_IMAGES = ROCKETCHAT_IMAGE_CAPS.perMessage;

const MAX_IMAGE_BYTES = ROCKETCHAT_IMAGE_CAPS.bytes;

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
async function downloadTurnImages(
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
function makeImageResolver(auth: RocketChatRestAuth): ImageResolver {
  return async (image) => {
    const bytes = await fetchAttachmentBytes(auth, image.ref, MAX_IMAGE_BYTES);
    return bytes ? bytes.toString('base64') : null;
  };
}

interface FastTurnInputs {
  tools: ChatToolset;
  images: TurnImage[];
  resolveImage: ImageResolver;
}

export async function prepareFastTurn(opts: {
  route: { projectId: string; projectSlug: string };
  /** The token minted for the person this turn answers (`credentials/turn-credential.ts`). */
  credential: TurnCredential;
  /** The room and its linked speaker, for the tools that write on the speaker's behalf (ISS-1034). */
  turn: ChatTurnFacts;
  restAuth: RocketChatRestAuth;
  rid: string;
  /** The thread this venue is, where it is one; a thread is its own conversation (ISS-1090). */
  tmid?: string | undefined;
  images: readonly RocketChatImageRef[];
}): Promise<FastTurnInputs> {
  const images = await downloadTurnImages(opts.restAuth, opts.images);
  const ctx = buildChatToolContext({
    credential: opts.credential,
    projectSlug: opts.route.projectSlug,
    turn: { ...opts.turn, images },
  });
  return {
    images,
    resolveImage: makeImageResolver(opts.restAuth),
    tools: withTurnImages(
      mergeToolsets(
        buildProjectToolset(ctx),
        buildRocketChatHistoryToolset(opts.restAuth, opts.rid),
        buildRocketChatQuoteContextToolset(opts.restAuth, opts.rid),
        ...transcriptSearchToolsets({ ...opts, principalUserId: opts.credential.principal.userId }),
        buildEscalationToolset(),
      ),
      images,
    ),
  };
}

/**
 * The room's own past, where this turn has a room to ask about.
 */
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
