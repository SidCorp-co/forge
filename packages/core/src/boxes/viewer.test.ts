import { describe, expect, it, vi } from 'vitest';
import { recordPersonInput } from './acts.js';
import { holderLine, viewerBytesFor } from './viewer.js';

vi.mock('./acts.js', () => ({ recordPersonInput: vi.fn() }));

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
