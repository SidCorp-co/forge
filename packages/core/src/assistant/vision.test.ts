import { describe, expect, it, vi } from 'vitest';
import type { StoredChatMessage } from './session.js';
import {
  base64Bytes,
  resolveVisionImages,
  type TurnImage,
  VISION_BUDGET_BYTES,
  VISION_LOOKBACK_TURNS,
} from './vision.js';

function img(n: number): { name: string; mime: string; ref: string } {
  return {
    name: `s${n}.png`,
    mime: 'image/png',
    ref: `https://chat.example.com/file-upload/${n}/s.png`,
  };
}

function userTurn(text: string, images: Array<{ name: string; mime: string; ref: string }> = []) {
  return {
    role: 'user' as const,
    content: text,
    ts: '2026-08-31T00:00:00.000Z',
    ...(images.length > 0 ? { images } : {}),
  } satisfies StoredChatMessage;
}

const b64 = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4);

describe('base64Bytes', () => {
  it('reports the decoded length without decoding', () => {
    expect(base64Bytes(Buffer.from('hello').toString('base64'))).toBe(5);
    expect(base64Bytes(Buffer.alloc(1234, 7).toString('base64'))).toBe(1234);
  });
});

describe('resolveVisionImages', () => {
  it('sends the current turn image without calling the resolver', async () => {
    const resolve = vi.fn();
    const inHand: TurnImage[] = [{ ...img(1), dataBase64: 'QUJD' }];
    const out = await resolveVisionImages([userTurn('look', [img(1)])], inHand, resolve);
    expect(out.get(img(1).ref)).toBe('data:image/png;base64,QUJD');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('re-fetches an earlier turn image so a follow-up question still sees it', async () => {
    const resolve = vi.fn().mockResolvedValue('QUJD');
    const messages = [
      userTurn('analyse this', [img(1)]),
      { role: 'assistant' as const, content: 'ok', ts: 'x' },
      userTurn('so what should change?'),
    ];
    const out = await resolveVisionImages(messages, [], resolve);
    expect(out.get(img(1).ref)).toBe('data:image/png;base64,QUJD');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${VISION_LOOKBACK_TURNS} image-bearing turns`, async () => {
    const resolve = vi.fn().mockResolvedValue('QUJD');
    const messages = [userTurn('a', [img(1)]), userTurn('b', [img(2)]), userTurn('c', [img(3)])];
    const out = await resolveVisionImages(messages, [], resolve);
    expect([...out.keys()]).toEqual([img(3).ref, img(2).ref]);
    expect(out.has(img(1).ref)).toBe(false);
  });

  it('drops an image that would blow the byte budget, keeping the newer one', async () => {
    const big = b64(VISION_BUDGET_BYTES);
    const small = b64(1000);
    const resolve = vi.fn(async (i: { ref: string }) => (i.ref === img(2).ref ? small : big));
    const messages = [userTurn('older', [img(1)]), userTurn('newer', [img(2)])];
    const out = await resolveVisionImages(messages, [], resolve);
    expect(out.has(img(2).ref)).toBe(true);
    expect(out.has(img(1).ref)).toBe(false);
  });

  it('degrades to no image rather than failing the turn when the fetch throws', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('403'));
    const out = await resolveVisionImages([userTurn('look', [img(1)])], [], resolve);
    expect(out.size).toBe(0);
  });

  it('resolves nothing when no resolver is supplied and nothing is in hand', async () => {
    const out = await resolveVisionImages([userTurn('look', [img(1)])], []);
    expect(out.size).toBe(0);
  });
});
