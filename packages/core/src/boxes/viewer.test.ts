import { describe, expect, it } from 'vitest';
import { viewerBytesFor } from './viewer.js';

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
