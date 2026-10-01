// @gate-input whole-tree
import { beforeAll, describe, expect, it } from 'vitest';
import { pinnedOasdiff } from './oasdiff.fixture.js';
import { OASDIFF_VERSION, requireOasdiff } from './oasdiff.js';
import { diffOpenApi, openApiElements } from './openapi-diff.js';

describe('the pinned oasdiff binary', () => {
  it('refuses a binary of another version', async () => {
    await expect(requireOasdiff({ OASDIFF_BIN: '/bin/echo' })).rejects.toThrow(
      `pinned to oasdiff ${OASDIFF_VERSION}`,
    );
  });
});

const spec = (paths: Record<string, unknown>) =>
  JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths });
const op = (body: object | null, extra: object = {}) => ({
  ...(body
    ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
    : {}),
  responses: { default: { description: 'undeclared' } },
  ...extra,
});
const BODY = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

describe('the real oasdiff, run on two specs', () => {
  beforeAll(async () => {
    await pinnedOasdiff();
  }, 120_000);

  it('a removed route is breaking and names the route', async () => {
    const d = await diffOpenApi(
      spec({ '/api/a': { get: op(null) }, '/api/b': { get: op(null) } }),
      spec({ '/api/a': { get: op(null) } }),
    );
    expect(d.tool).toBe('oasdiff');
    expect(d.toolVersion).toBe(OASDIFF_VERSION);
    expect(d.classification).toBe('breaking');
    expect(d.changes.find((c) => c.level === 'breaking')?.element).toBe('GET /api/b');
  });

  it('a new required request property is breaking', async () => {
    const wider = {
      ...BODY,
      properties: { ...BODY.properties, policy: { type: 'string' } },
      required: ['title', 'policy'],
    };
    const d = await diffOpenApi(
      spec({ '/api/a': { post: op(BODY) } }),
      spec({ '/api/a': { post: op(wider) } }),
    );
    expect(d.classification).toBe('breaking');
    expect(d.changes.map((c) => c.check)).toContain('new-required-request-property');
  });

  it('a new route is non-breaking', async () => {
    const d = await diffOpenApi(
      spec({ '/api/a': { get: op(null) } }),
      spec({ '/api/a': { get: op(null) }, '/api/c': { get: op(null) } }),
    );
    expect(d.classification).toBe('non-breaking');
    expect(d.changes.map((c) => `${c.element}:${c.kind}`)).toContain('GET /api/c:added');
  });

  it('a gate added to a route is unknown, because oasdiff has no check for it', async () => {
    const d = await diffOpenApi(
      spec({ '/api/a': { get: op(null) } }),
      spec({ '/api/a': { get: op(null, { 'x-forge-auth': ['requireAuth'] }) } }),
    );
    expect(d.classification).toBe('unknown');
  });

  it('lists the operations of a spec as its elements', () => {
    expect(
      openApiElements(
        JSON.parse(spec({ '/api/a': { get: op(null), post: op(BODY), parameters: [] } })),
      ),
    ).toEqual(['GET /api/a', 'POST /api/a']);
  });
});
