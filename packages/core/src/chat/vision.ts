/**
 * Which of a transcript's images are re-sent to the model this turn, and the
 * budget that bounds them.
 *
 * A chat session lives as long as its channel and the model only ever sees a
 * window of it, so "the picture the user is asking about" is not always the
 * one that arrived this turn — a design review is three questions about one
 * screenshot. Images are stored by reference (see `session.ts`), so replaying
 * them means paying a fetch; this module decides how many fetches are worth it.
 */

import type { StoredChatImage, StoredChatMessage } from './session.js';

/**
 * How many image-bearing user turns, newest-first, are eligible to be re-sent.
 * 1 would make every follow-up question ("so what should the layout be?")
 * answer blind; the number is small because each turn's images are re-fetched
 * and re-uploaded to the model on EVERY subsequent turn they stay eligible for.
 */
export const VISION_LOOKBACK_TURNS = 2;

/**
 * Total raw image bytes a single request may carry, filled newest-first.
 * base64 inflates by ~4/3, so this is ~8 MB on the wire — under Gemini's
 * ~20 MB inline-request ceiling with room for the transcript and the tool
 * catalog. Deliberately ONE budget rather than a per-image cap: two 3 MB
 * screenshots and six small ones are the same cost to the request, and a
 * per-image cap prices neither.
 */
export const VISION_BUDGET_BYTES = 6_000_000;

export interface TurnImage extends StoredChatImage {
  /** Raw bytes, base64-encoded — no `data:` prefix. */
  dataBase64: string;
}

/** Fetch the bytes behind a stored reference, or null when unavailable. */
export type ImageResolver = (image: StoredChatImage) => Promise<string | null>;

function dataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Build the `ref → data:` map {@link toProviderMessages} needs. `inHand`
 * covers images that arrived with the current turn (already downloaded, never
 * re-fetched); anything older goes through `resolve`, and a resolver failure
 * is skipped rather than failing the turn — an answer without the picture
 * beats no answer.
 */
export async function resolveVisionImages(
  messages: readonly StoredChatMessage[],
  inHand: readonly TurnImage[],
  resolve?: ImageResolver,
): Promise<Map<string, string>> {
  const byRef = new Map(inHand.map((i) => [i.ref, i.dataBase64] as const));
  const out = new Map<string, string>();
  let budget = VISION_BUDGET_BYTES;
  let turns = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const images = messages[i]?.images;
    if (!images || images.length === 0) continue;
    if (++turns > VISION_LOOKBACK_TURNS) break;
    for (const image of images) {
      if (out.has(image.ref)) continue;
      let b64 = byRef.get(image.ref) ?? null;
      if (b64 === null && resolve) {
        try {
          b64 = await resolve(image);
        } catch {
          b64 = null;
        }
      }
      if (b64 === null || b64.length === 0) continue;
      const size = base64Bytes(b64);
      if (size > budget) continue;
      budget -= size;
      out.set(image.ref, dataUri(image.mime, b64));
    }
  }
  return out;
}
