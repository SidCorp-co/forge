import { describe, expect, it } from 'vitest';
import { app } from './index.js';

describe('@forge/core health endpoint', () => {
  it('returns { ok: true } on GET /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
