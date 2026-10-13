import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refuses } from '../middleware/declarations.js';
import { buildReference, openApiPath } from './build.js';
import { describeOperation, empty, fail, json, raw, redirect } from './describe.js';
import { zValidator } from './validator.js';

const gate = refuses(
  async (_c: unknown, next: () => Promise<void>) => next(),
  [{ status: 401, code: 'UNAUTHENTICATED', when: 'no credential' }],
);

const refuseWith = (code: string) => (r: { success: boolean }) => {
  if (!r.success) throw new HTTPException(400, { message: 'no', cause: { code } });
};

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
    const responses = (
      document.paths['/api/issues/{id}']?.get as { responses: Record<string, unknown> }
    ).responses;
    const schema = JSON.stringify(responses['400']);
    expect(schema).toContain('BAD_ISSUE_ID');
  });

  it('gives a validator with no hook the library default 400', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const responses = (
      document.paths['/api/issues']?.post as { responses: Record<string, { description: string }> }
    ).responses;
    expect(responses['400']?.description).toContain('no hook');
  });

  it('merges a gate refusal with the descriptor and the unexpected-failure answer', async () => {
    const { document } = await buildReference(planted(), { version: 't' });
    const responses = (
      document.paths['/api/issues/{id}']?.get as { responses: Record<string, unknown> }
    ).responses;
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
    const token = JSON.stringify(
      (document.paths['/api/issues']?.get as { responses: unknown }).responses,
    );
    const open = JSON.stringify((document.paths['/pair']?.get as { responses: unknown }).responses);
    expect(token).toContain('PAT_PERMISSION_REQUIRED');
    expect(open).not.toContain('PAT_PERMISSION_REQUIRED');
  });

  it('is deterministic: two builds of one app give one document', async () => {
    const a = await buildReference(planted(), { version: 't' });
    const b = await buildReference(planted(), { version: 't' });
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
  });
});
