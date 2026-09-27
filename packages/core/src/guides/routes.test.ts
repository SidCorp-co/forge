import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com', NODE_ENV: 'test' },
}));

const { guideRoutes } = await import('./routes.js');

const app = new Hono().route('/api', guideRoutes);

describe('the public guide surface', () => {
  it('points llms.txt at the readable pages as well as the markdown', async () => {
    const res = await app.request('/api/llms.txt');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('https://forge.example.com/guides');
    expect(body).toContain('/api/guides/what-is-an-issue.md');
  });

  it('tells a caller who asked for an unknown slug where the readable index is', async () => {
    const res = await app.request('/api/guides/no-such-guide');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('https://forge.example.com/guides');
  });

  it('serves the index and one guide with no credential', async () => {
    expect((await app.request('/api/guides')).status).toBe(200);
    expect((await app.request('/api/guides/what-is-an-issue.md')).status).toBe(200);
  });

  it('says who each guide is written for, in the index and on the guide', async () => {
    const index = (await (await app.request('/api/guides')).json()) as {
      guides: Array<{ slug: string; audience?: string }>;
    };
    expect(index.guides.length).toBeGreaterThan(10);
    for (const g of index.guides) expect(g.audience, g.slug).toBe('agent');

    const one = (await (await app.request('/api/guides/what-is-an-issue')).json()) as {
      guide: { audience?: string };
    };
    expect(one.guide.audience).toBe('agent');
  });
});
