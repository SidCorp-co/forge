// A browser box's picture as Forge holds it (ISS-1386): the frame agent-browser's stream sends a
// joining client at once, read over the same tunnel a viewer's comes by (`./frame-relay.ts`), so
// core holds the bytes of what the screen shows without the device sending a file. A box that
// sends none within the relay's wait, or a frame that is no picture, is said by name.

import { openBoxStream } from '../previews/index.js';
import { relayFrames } from './frame-relay.js';
import { rowOf } from './service.js';

export type BoxShot =
  | { ok: true; bytes: Buffer; mime: 'image/jpeg' | 'image/png' }
  | { ok: false; why: string };

/** The picture's type by its first bytes; null where it is neither a jpeg nor a png. */
export function shotMime(bytes: Buffer): 'image/jpeg' | 'image/png' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

/** The frame a viewer would be sent first, as a picture. */
export function shotOfFrame(text: string): BoxShot {
  const data = (JSON.parse(text) as { data?: unknown }).data;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.alloc(0);
  const mime = shotMime(bytes);
  return mime ? { ok: true, bytes, mime } : { ok: false, why: 'its frame is no jpeg or png' };
}

/** Take one picture of a running browser box's screen. */
export async function boxShot(boxId: string): Promise<BoxShot> {
  const row = await rowOf(boxId);
  if (row.mode !== 'browser') return { ok: false, why: `a ${row.mode} box sends no frame` };
  const open = () => openBoxStream(row.deviceId, { boxId, channel: 'view', fps: 1 });
  const first = await open();
  if (!first.ok) return { ok: false, why: `the box's device cannot be reached (${first.why})` };
  return new Promise<BoxShot>((resolve) => {
    const closers: (() => void)[] = [];
    let done = false;
    const end = (shot: BoxShot) => {
      if (done) return;
      done = true;
      resolve(shot);
      for (const close of closers) close();
    };
    relayFrames(
      boxId,
      {
        frame: (text) => end(shotOfFrame(text)),
        fail: (code, why) => end({ ok: false, why: `${code}: ${why}` }),
        onClose: (fn) => closers.push(fn),
      },
      first.stream,
      open,
      1,
    );
  });
}
