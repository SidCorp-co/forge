import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRow } from '../db/schema-boxes.js';
import { recordPersonInput } from './acts.js';
import { boxById } from './read.js';
import { followHold, holderLine, viewerBytesFor } from './viewer.js';

vi.mock('./acts.js', () => ({ recordPersonInput: vi.fn() }));
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read.js')>()),
  boxById: vi.fn(),
}));

describe('what a viewer sends over its view reaches the box only for RFB', () => {
  const bytes = Buffer.from('RFB 003.008\n');

  it('carries an RFB viewer’s binary handshake on to x11vnc', () => {
    expect(viewerBytesFor('rfb', bytes, true)).toEqual(bytes);
    expect(viewerBytesFor('rfb', [bytes.subarray(0, 4), bytes.subarray(4)], true)).toEqual(bytes);
  });

  it('drops an RFB viewer’s text message', () => {
    expect(viewerBytesFor('rfb', bytes, false)).toBeNull();
  });

  it('drops everything a JPEG-frames or scrcpy viewer sends, since agent-browser’s socket takes input', () => {
    expect(viewerBytesFor('jpeg-frames', bytes, true)).toBeNull();
    expect(viewerBytesFor('jpeg-frames', Buffer.from('{"type":"input_mouse"}'), false)).toBeNull();
    expect(viewerBytesFor('scrcpy-h264', bytes, true)).toBeNull();
  });
});

describe('a holder’s input line is recorded before it is forwarded', () => {
  const line = JSON.stringify({ t: 'text', text: 'a' });
  const sink = () => ({
    refuse: vi.fn(),
    forward: vi.fn(),
    notHeld: vi.fn(),
    unrecorded: vi.fn(),
  });

  it('forwards a recorded input', async () => {
    vi.mocked(recordPersonInput).mockResolvedValueOnce(true);
    const to = sink();
    await holderLine('box-1', 'user-1', line, to);
    expect(to.forward).toHaveBeenCalledWith(`${line}\n`);
  });

  it('ends the socket, never rejecting, where the record cannot be written', async () => {
    vi.mocked(recordPersonInput).mockRejectedValueOnce(new Error('connection terminated'));
    const to = sink();
    await expect(holderLine('box-1', 'user-1', line, to)).resolves.toBeUndefined();
    expect(to.unrecorded).toHaveBeenCalledTimes(1);
    expect(to.forward).not.toHaveBeenCalled();
  });

  it('ends the hold where the person no longer holds the box, and refuses a line no BoxInput', async () => {
    vi.mocked(recordPersonInput).mockResolvedValueOnce(false);
    const to = sink();
    await holderLine('box-1', 'user-1', line, to);
    expect(to.notHeld).toHaveBeenCalledTimes(1);
    await holderLine('box-1', 'user-1', 'not json', to);
    expect(to.refuse).toHaveBeenCalledTimes(1);
    expect(to.forward).not.toHaveBeenCalled();
  });
});

describe('a viewer follows the hold until the box stops running', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the socket through a read that failed, and closes once the box reads closed', async () => {
    const ws = { readyState: 1, OPEN: 1, send: vi.fn(), on: vi.fn() } as const;
    const onEnd = vi.fn();
    vi.mocked(boxById)
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValueOnce({ id: 'box-1', state: 'closed' } as BoxRow);
    followHold(ws as never, 'box-1', onEnd);

    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0]?.[0] as string)).toEqual({
      type: 'closed',
      why: 'the box is closed',
    });
  });
});
