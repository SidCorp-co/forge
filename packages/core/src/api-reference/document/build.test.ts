import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refuses } from '../../middleware/declarations.js';
import { describeOperation, empty, fail, json, raw, redirect } from '../declare/describe.js';
import { zValidator } from '../declare/validator.js';
import { buildReference, openApiPath } from './build.js';

const gate = refuses(
  async (_c: unknown, next: () => Promise<void>) => next(),
  [{ status: 401, code: 'UNAUTHENTICATED', when: 'no credential' }],
);

const refuseWith = (code: string) => (r: { success: boolean }) => {
  if (!r.success) throw new HTTPException(400, { message: 'no', cause: { code } });
};

/** The responses of one operation of the document, refusing by name when the document has none. */
function responsesAt(
  document: { paths: Record<string, Record<string, unknown>> },
  path: string,
  method: string,
): Record<string, { description: string }> {
  const operation = document.paths[path]?.[method] as
    | { responses: Record<string, { description: string }> }
    | undefined;
  if (!operation) throw new Error(`the document has no ${method} ${path}`);
  return operation.responses;
}

function planted() {
  const app = new Hono();
  const idParam = z.object({ id: z.uuid() });
  const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });
  const body = z.object({ name: z.string().min(1), when: z.date().optional() });
  app.use('/api/issues/*', gate as never);
  app.get(
    '/api/issues/:id',
    zValidator('param', idParam, refuseWith('BAD_ISSUE_ID')),
    describeOperation({
      summary: 'Read one issue',
      responses: {
        200: json(z.object({ id: z.string(), createdAt: z.date() }), 'The issue'),
        404: fail('NOT_FOUND', 'no such issue'),
      },
    }),
    (c) => c.json({ id: c.req.valid('param').id, createdAt: new Date() }),
  );
  app.get(
    '/api/issues',
    zValidator('query', listQuery, refuseWith('BAD_LIMIT')),
    describeOperation({ summary: 'List issues', responses: { 200: json(z.array(z.string())) } }),
    (c) => c.json([]),
  );
  app.post(
    '/api/issues',
    zValidator('json', body),
    describeOperation({
      summary: 'Open an issue',
      responses: { 201: json(z.object({ id: z.string() })), 409: fail({ DUP: 'same title' }) },
    }),
    (c) => c.json({ id: 'x' }, 201),
  );
  app.delete(
    '/api/issues/:id',
    describeOperation({ summary: 'Drop an issue', responses: { 204: empty() } }),
    (c) => c.body(null, 204),
  );
  app.get(
    '/pair',
    describeOperation({ summary: 'Pair', responses: { 302: redirect('to the web app') } }),
    (c) => c.redirect('/x'),
  );
  app.get(
    '/api/install.sh',
    describeOperation({ summary: 'Script', responses: { 200: raw('text/x-shellscript', 'sh') } }),
    (c) => c.text('#!/bin/sh'),
  );
  return app;
}

describe('openApiPath', () => {
  it.each([
    ['/api/issues/:id', '/api/issues/{id}'],
    ['/api/projects/:projectId/issues/:id{[0-9]+}', '/api/projects/{projectId}/issues/{id}'],
    ['/api/x/:slug?', '/api/x/{slug}'],
    ['/health', '/health'],
  ])('writes %s as %s', (hono, openapi) => {
    expect(openApiPath(hono)).toBe(openapi);
  });
});

describe('buildReference over a planted app', () => {
  it('makes every route an operation, including a route outside /api', async () => {
    const { document, routes } = await buildReference(planted(), { version: 't' });
    expect(routes.map((r) => r.key).sort()).toEqual(
      [
        'DELETE /api/issues/:id',
        'GET /api/install.sh',
        'GET /api/issues',
        'GET /api/issues/:id',
        'GET /pair',
        'POST /api/issues',
      ].sort(),
    );
    expect(Object.keys(document.paths).sort()).toEqual(
      ['/api/install.sh', '/api/issues', '/api/issues/{id}', '/pair'].sort(),
    );
  });

  it('states a path parameter as the schema the validator holds', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const op = document.paths['/api/issues/{id}']?.get as {
      parameters: Array<Record<string, unknown>>;
    };
    expect(op.parameters).toEqual([
      expect.objectContaining({
        name: 'id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ format: 'uuid' }),
      }),
    ]);
  });

  it('states a query as optional where its schema defaults it', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const op = document.paths['/api/issues']?.get as { parameters: Array<Record<string, unknown>> };
    expect(op.parameters[0]).toMatchObject({ name: 'limit', in: 'query', required: false });
    expect(op.parameters[0]?.schema).toMatchObject({ minimum: 1, maximum: 50, default: 10 });
  });

  it('reads a request body and renders a date as a date-time string', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const op = document.paths['/api/issues']?.post as {
      requestBody: {
        content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
      };
    };
    expect(op.requestBody.content['application/json'].schema.properties.when).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
  });

  it('reads the refusal a validator hook sends by running the hook', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const responses = responsesAt(document, '/api/issues/{id}', 'get');
    const schema = JSON.stringify(responses['400']);
    expect(schema).toContain('BAD_ISSUE_ID');
  });

  it('gives a validator with no hook the envelope 400 it refuses with (ISS-1421 r14)', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const responses = responsesAt(document, '/api/issues', 'post');
    expect(JSON.stringify(responses['400'])).toContain('BAD_REQUEST');
    expect(JSON.stringify(responses['400'])).not.toContain('"success"');
  });

  it('keeps both refusals of a route whose parameter validator has a hook and whose body validator has none, in the envelope', async () => {
    const app = new Hono();
    app.post(
      '/api/mixed/:id',
      zValidator('param', z.object({ id: z.uuid() }), refuseWith('BAD_MIXED_ID')),
      zValidator('json', z.object({ name: z.string() })),
      describeOperation({ summary: 'Mixed', responses: { 200: json(z.object({})) } }),
      (c) => c.json({}),
    );
    const { document } = await buildReference(app, { version: 't' });
    const alternatives = JSON.stringify(responsesAt(document, '/api/mixed/{id}', 'post')['400']);
    expect(alternatives).toContain('BAD_MIXED_ID');
    expect(alternatives).toContain('BAD_REQUEST');
    expect(alternatives).not.toContain('"success"');
  });

  it('keeps a declared JSON refusal and the envelope a hook throws, at one status', async () => {
    const app = new Hono();
    app.get(
      '/api/both/:id',
      zValidator('param', z.object({ id: z.uuid() }), refuseWith('BAD_ID')),
      describeOperation({
        summary: 'Both',
        responses: {
          200: json(z.object({})),
          400: json(z.object({ reason: z.string() }), 'legacy'),
        },
      }),
      (c) => c.json({}),
    );
    const { document } = await buildReference(app, { version: 't' });
    const refusal = JSON.stringify(responsesAt(document, '/api/both/{id}', 'get')['400']);
    expect(refusal).toContain('reason');
    expect(refusal).toContain('BAD_ID');
    expect(refusal).toContain('anyOf');
  });

  it('states a multipart body as an object whose named file part is required, and a second body type beside the JSON one', async () => {
    const app = new Hono();
    app.post(
      '/api/up',
      describeOperation({
        summary: 'Upload',
        body: { contentType: 'multipart/form-data', description: 'a file', filePart: 'file' },
        responses: { 200: json(z.object({}), 'Stored', 'text/markdown') },
      }),
      (c) => c.json({}),
    );
    const { document } = await buildReference(app, { version: 't' });
    const operation = document.paths['/api/up']?.post as {
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, { content: Record<string, unknown> }>;
    };
    expect(operation.requestBody.content['multipart/form-data']?.schema).toEqual({
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    });
    expect(Object.keys(operation.responses['200']?.content ?? {}).sort()).toEqual([
      'application/json',
      'text/markdown',
    ]);
  });

  it('merges a gate refusal with the descriptor and the unexpected-failure answer', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const responses = responsesAt(document, '/api/issues/{id}', 'get');
    expect(Object.keys(responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '429',
      '500',
    ]);
    expect(JSON.stringify(responses['401'])).toContain('UNAUTHENTICATED');
    expect(JSON.stringify(responses['404'])).toContain('NOT_FOUND');
  });

  it('keeps the answers that are not JSON bodies as what they are', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    expect(document.paths['/pair']?.get?.responses).toMatchObject({
      302: { headers: { Location: expect.anything() } },
    });
    expect(document.paths['/api/install.sh']?.get?.responses).toMatchObject({
      200: { content: { 'text/x-shellscript': expect.anything() } },
    });
    expect(document.paths['/api/issues/{id}']?.delete?.responses).toMatchObject({
      204: { description: expect.any(String) },
    });
  });

  it('names the grant a token needs, read from the permission map, and the door of an exclusion', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const read = document.paths['/api/issues/{id}']?.get as Record<string, unknown>;
    const write = document.paths['/api/issues']?.post as Record<string, unknown>;
    const pair = document.paths['/pair']?.get as Record<string, unknown>;
    expect(read['x-forge-access']).toMatchObject({ door: 'token', permission: 'issues:read' });
    expect(write['x-forge-access']).toMatchObject({ door: 'token', permission: 'issues:write' });
    expect(pair['x-forge-access']).toMatchObject({ door: 'public', excludedBy: '/pair' });
    expect(pair.security).toEqual([]);
    expect(read.security).toEqual([{ bearerAuth: [] }]);
  });

  it('adds the credential door refusals to a token route and not to a public one', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const token = JSON.stringify(responsesAt(document, '/api/issues', 'get'));
    const open = JSON.stringify(responsesAt(document, '/pair', 'get'));
    expect(token).toContain('PAT_PERMISSION_REQUIRED');
    expect(open).not.toContain('PAT_PERMISSION_REQUIRED');
  });

  it('is deterministic: two builds of one app give one document', async () => {
    const a = await buildReference(planted(), { version: 't' });
    const b = await buildReference(planted(), { version: 't' });
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
  });
});

describe('what a caller sends, read from the gates a route runs', () => {
  const described = (summary: string, description?: string) =>
    describeOperation({
      summary,
      ...(description ? { description } : {}),
      responses: { 200: json(z.object({})) },
    });

  function door() {
    const app = new Hono();
    app.post('/api/devices/login/init', described('Start a login', 'Public.'), (c) => c.json({}));
    app.get('/api/devices/me', gate as never, described('This box'), (c) => c.json({}));
    app.post('/mcp', described('MCP'), (c) => c.json({}));
    return app;
  }

  it('asks for no bearer on a route its door admits to a box when none of its gates read one', async () => {
    const { document } = await buildReference(door(), { version: 't' });
    const login = document.paths['/api/devices/login/init']?.post as Record<string, unknown>;
    expect(login.security).toEqual([]);
    expect(login.description).toContain(
      '**Bearer:** not read. This route takes no bearer token; any other credential it reads is named in its inputs.',
    );
    const credentialRefusals = JSON.stringify(
      responsesAt(document, '/api/devices/login/init', 'post'),
    );
    expect(credentialRefusals).not.toContain('INVALID_TOKEN');
  });

  it('asks for a bearer where a gate reads one, and by name on the MCP door, which declares none', async () => {
    const { document } = await buildReference(door(), { version: 't' });
    expect(document.paths['/api/devices/me']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/mcp']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(String(document.paths['/api/devices/me']?.get?.description)).not.toContain('Bearer:');
  });

  it('names no permission in x-forge-access on a route the grant map files but whose gates read no bearer', async () => {
    const app = new Hono();
    app.get('/api/invitations/:token', described('Preview an invitation'), (c) => c.json({}));
    app.get('/api/issues', gate as never, described('List'), (c) => c.json({}));
    const { document } = await buildReference(app, { version: 't' });
    const preview = document.paths['/api/invitations/{token}']?.get as Record<string, unknown>;
    expect(preview['x-forge-access']).toEqual({ door: 'none', reason: expect.any(String) });
    expect(preview.security).toEqual([]);
    expect(document.paths['/api/issues']?.get?.['x-forge-access']).toMatchObject({
      door: 'token',
      permission: 'issues:read',
    });
  });

  it('does not read a gate registered after the route, which never runs for it', async () => {
    const app = new Hono();
    app.get('/api/issues', described('List'), (c) => c.json({}));
    app.use('/api/issues', gate as never);
    const { document, routes } = await buildReference(app, { version: 't' });
    expect(routes[0]?.takesBearer).toBe(false);
    expect(JSON.stringify(responsesAt(document, '/api/issues', 'get'))).not.toContain(
      'UNAUTHENTICATED',
    );
  });

  it("prints the permission or the door at the head of the description, ahead of the route's own words", async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const read = String(document.paths['/api/issues/{id}']?.get?.description);
    expect(read).toMatch(/^\*\*Permission:\*\* `issues:read`\./);
    const pair = String(document.paths['/pair']?.get?.description);
    expect(pair).toMatch(/^\*\*Door:\*\* `public`\./);
    const login = String(
      (await buildReference(door(), { version: 't' })).document.paths['/api/devices/login/init']
        ?.post?.description,
    );
    expect(login.endsWith('Public.')).toBe(true);
  });
});
