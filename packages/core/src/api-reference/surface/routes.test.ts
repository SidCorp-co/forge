import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PAT_UNGRANTABLE, patUngrantableFor } from '../../auth/pat-permissions.js';
import { describeOperation, json } from '../declare/describe.js';
import { referenceOf } from './routes.js';

/** The three pages, read through the composed app with no credential on the request. */
let app: Hono;

beforeAll(async () => {
  ({ app } = (await import('../../index.js')) as unknown as { app: Hono });
}, 120_000);

describe('GET /api/openapi.json', () => {
  it('answers 200 with an OpenAPI 3.1 document to a request that carries no credential', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const document = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).length).toBeGreaterThan(400);
  });

  it('carries itself, and the routes a token cannot reach, as operations that need no credential', async () => {
    const document = (await (await app.request('/api/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { security: unknown[]; 'x-forge-access': { door: string } }>
      >;
    };
    expect(document.paths['/api/openapi.json']?.get).toMatchObject({
      security: [],
      'x-forge-access': { door: 'public' },
    });
    expect(document.paths['/api/issues/{id}']?.get).toMatchObject({
      'x-forge-access': { door: 'token', permission: 'issues:read' },
    });
  });

  it('serves the same text to two requests at once', async () => {
    const [a, b] = await Promise.all([
      app.request('/api/openapi.json'),
      app.request('/api/openapi.json'),
    ]);
    expect(await a.text()).toBe(await b.text());
  });

  it('declares the object it answers, not a string', async () => {
    const document = (await (await app.request('/api/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<
          string,
          { responses: Record<string, { content: Record<string, { schema: unknown }> }> }
        >
      >;
    };
    const schema =
      document.paths['/api/openapi.json']?.get?.responses['200']?.content['application/json']
        ?.schema;
    expect(schema).toMatchObject({ type: 'object', required: ['openapi', 'info', 'paths'] });
  });

  it('refuses a method it does not serve, by name, and not by serving the document', async () => {
    const res = await app.request('/api/openapi.json', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/reference', () => {
  it('answers 200 with a page that reads the document, to a request with no credential', async () => {
    const res = await app.request('/api/reference');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('data-url="/api/openapi.json"');
    expect(html).toContain('<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@');
  });
});

describe('GET /api/reference/flows', () => {
  it('answers 200 with a diagram for each of the four flows, to a request with no credential', async () => {
    const res = await app.request('/api/reference/flows');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/<pre class="mermaid">/g)).toHaveLength(4);
    for (const id of [
      'pair-a-runner',
      'claim-and-finish-a-job',
      'move-an-issue',
      'grant-and-use-a-token',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('mermaid.initialize');
  });
});

describe('the reference paths are kept out of the token grant by name', () => {
  it.each(['/api/openapi.json', '/api/reference', '/api/reference/flows'])('%s', (path) => {
    expect(patUngrantableFor(path, 'GET')).toMatchObject({ admits: 'public' });
    expect(PAT_UNGRANTABLE['/api/openapi.json']?.reason).toBeTruthy();
    expect(PAT_UNGRANTABLE['/api/reference']?.reason).toBeTruthy();
  });
});

describe('referenceOf', () => {
  it('reads the route table once for however many requests ask, at once or later', async () => {
    let reads = 0;
    const source = new Hono();
    source.get(
      '/ping',
      describeOperation({ summary: 'Ping', responses: { 200: json(z.object({})) } }),
      (c) => c.json({}),
    );
    const reference = referenceOf(() => {
      reads += 1;
      return source;
    });
    const [a, b] = await Promise.all([reference(), reference()]);
    const c = await reference();
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(reads).toBe(1);
  });
});
