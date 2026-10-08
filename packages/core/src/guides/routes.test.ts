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

describe('the public index states the corpus it is part of (ISS-1329)', () => {
  it('says in its own field that the list is not complete, and where the rest is', async () => {
    const index = (await (await app.request('/api/guides')).json()) as {
      guides: Array<{ slug: string }>;
      corpus?: {
        complete: boolean;
        reach: string;
        authority: string;
        cliServed: Array<{ slug: string; covers: string }>;
      };
    };
    expect(index.corpus?.complete).toBe(false);
    expect(index.corpus?.reach).toContain('forge guide');
    expect(index.corpus?.authority).toContain('authoritative');
    expect(index.corpus?.cliServed.length).toBeGreaterThan(0);
  });

  it('never lists as served here a guide it names as served by the CLI', async () => {
    const index = (await (await app.request('/api/guides')).json()) as {
      guides: Array<{ slug: string }>;
      corpus: { cliServed: Array<{ slug: string }> };
    };
    const served = new Set(index.guides.map((g) => g.slug));
    const both = index.corpus.cliServed.map((g) => g.slug).filter((s) => served.has(s));
    expect(both).toEqual([]);
  });

  it('answers a method guide with a 404 that says the CLI serves it', async () => {
    const res = await app.request('/api/guides/dispatch.md');
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('forge CLI');
    expect(text).toContain('Valid slugs:');
  });

  it('states the same in llms.txt', async () => {
    const body = await (await app.request('/api/llms.txt')).text();
    expect(body).toContain('Not listed here');
    expect(body).toContain('forge guide');
    expect(body).toContain('authoritative');
  });

  it('serves the capability guide as markdown and lists it', async () => {
    const md = await app.request('/api/guides/what-forge-is.md');
    expect(md.status).toBe(200);
    expect(await md.text()).toContain('What Forge is and what it can do');
    const index = (await (await app.request('/api/guides')).json()) as {
      guides: Array<{ slug: string }>;
    };
    expect(index.guides.map((g) => g.slug)).toContain('what-forge-is');
  });
});
