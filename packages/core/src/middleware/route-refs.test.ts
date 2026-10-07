import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { resolvingRouteRefs, unaddressableProjectSlug } from './route-refs.js';

// Which slugs no project route could address is read from the router the process serves, so a
// literal route added under /api/projects/ reserves its segment without anyone listing it.

describe('a project slug no route could address', () => {
  it('is every literal first segment under /api/projects/ the routed app spells, and a uuid', () => {
    const app = new Hono();
    app.get('/api/projects/zz-literal', (c) => c.text('literal'));
    app.get('/api/projects/zz-family/members', (c) => c.text('literal family'));
    app.get('/api/projects/:id', (c) => c.text('one project'));
    app.get('/api/orgs/zz-elsewhere', (c) => c.text('not a project route'));
    resolvingRouteRefs(app as unknown as Hono<never>, app.fetch);

    expect(unaddressableProjectSlug('zz-literal') ?? 'addressable').toContain(
      '/api/projects/zz-literal',
    );
    expect(unaddressableProjectSlug('zz-family') ?? 'addressable').toContain(
      '/api/projects/zz-family',
    );
    expect(unaddressableProjectSlug('3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11')).toContain('uuid');
    expect(unaddressableProjectSlug('health')).toBeNull();
    expect(unaddressableProjectSlug('zz-elsewhere')).toBeNull();
    expect(unaddressableProjectSlug('forge')).toBeNull();
  });
});
