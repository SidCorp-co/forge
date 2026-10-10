import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { byteRange, sendBytes } from './attachment-headers.js';

describe('byteRange', () => {
  it('reads a closed, an open and a suffix range', () => {
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('clamps an end past the body and a suffix longer than it', () => {
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(byteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('answers the whole body for no header, several ranges or another unit', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(byteRange('items=0-1', 100)).toBeNull();
    expect(byteRange('bytes=-', 100)).toBeNull();
    expect(byteRange('bytes=9-2', 100)).toBeNull();
  });

  it('calls a start past the end unsatisfiable', () => {
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('sendBytes', () => {
  const body = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
  const app = new Hono().get('/f', (c) => sendBytes(c, body));

  it('answers a range with 206 and the asked bytes', async () => {
    const res = await app.request('/f', { headers: { Range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 10),
    );
  });

  it('answers no range with 200, the whole body and Accept-Ranges', async () => {
    const res = await app.request('/f');
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('answers a range past the end with 416 naming the size', async () => {
    const res = await app.request('/f', { headers: { Range: 'bytes=200-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
  });
});
