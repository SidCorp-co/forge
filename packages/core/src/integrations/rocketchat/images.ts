/**
 * Fetch the images a Rocket.Chat message carries, for the two consumers that
 * need the bytes: the model (as content parts) and any issue the bot files
 * this turn (as attachments).
 *
 * Downloading happens HERE, at the edge that owns the bot credential, and the
 * credential never travels further — neither consumer is given a URL it would
 * have to authenticate.
 */

import { buildEscalationToolset } from '../../chat/tools/escalate.js';
import { type ChatToolset, mergeToolsets } from '../../chat/tools/mcp-adapter.js';
import { buildChatToolContext } from '../../chat/tools/principal.js';
import { buildProjectToolset } from '../../chat/tools/registry.js';
import { withTurnImages } from '../../chat/tools/turn-images.js';
import type { ImageResolver, TurnImage } from '../../chat/vision.js';
import { logger } from '../../logger.js';
import { buildRocketChatHistoryToolset } from './context.js';
import {
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

export async function prepareFastTurn(opts: {
  route: { principalUserId: string; projectId: string; projectSlug: string };
  restAuth: RocketChatRestAuth;
  rid: string;
  images: readonly RocketChatImageRef[];
  externalToolsets: ChatToolset[];
}): Promise<FastTurnInputs> {
  const images = await downloadTurnImages(opts.restAuth, opts.images);
  const ctx = buildChatToolContext({
    userId: opts.route.principalUserId,
    projectId: opts.route.projectId,
    projectSlug: opts.route.projectSlug,
  });
  return {
    images,
    resolveImage: makeImageResolver(opts.restAuth),
    tools: withTurnImages(
      mergeToolsets(
        buildProjectToolset(ctx),
        buildRocketChatHistoryToolset(opts.restAuth, opts.rid),
        buildEscalationToolset(),
        ...opts.externalToolsets,
      ),
      images,
    ),
  };
}
