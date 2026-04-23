import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, type RequestIdVars, requestId } from './request-id.js';

function makeApp() {
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.get('/echo', (c) => c.json({ id: c.get('requestId') }));
  return app;
}

describe('requestId middleware', () => {
  it('generates an id when the header is missing', async () => {
    const app = makeApp();
    const res = await app.request('/echo');
    const header = res.headers.get(REQUEST_ID_HEADER);
    const body = (await res.json()) as { id: string };
    expect(header).toBeTruthy();
    expect(header).toBe(body.id);
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses the incoming x-request-id header', async () => {
    const app = makeApp();
    const res = await app.request('/echo', {
      headers: { [REQUEST_ID_HEADER]: 'incoming-abc-123' },
    });
    const body = (await res.json()) as { id: string };
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('incoming-abc-123');
    expect(body.id).toBe('incoming-abc-123');
  });

  it('generates a fresh id when the incoming header is empty', async () => {
    const app = makeApp();
    const res = await app.request('/echo', { headers: { [REQUEST_ID_HEADER]: '' } });
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
