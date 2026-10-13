import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildReference } from './build.js';
import { judgeAnswer, responseConformance } from './conformance.js';
import { describeOperation, fail, json } from './describe.js';

const state = vi.hoisted(() => ({ RESPONSE_CONFORMANCE: '1' }));
vi.mock('../config/env.js', () => ({ env: state }));

const issue = z.object({ id: z.string(), createdAt: z.date(), title: z.string().nullable() });

function planted() {
  const app = new Hono();
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json(
          {
            code: (err.cause as { code?: string } | undefined)?.code ?? 'ERROR',
            message: err.message,
          },
          err.status,
        )
      : c.json({ code: 'INTERNAL_ERROR', message: 'x' }, 500),
  );
  const declare = describeOperation({
    summary: 'read',
    responses: { 200: json(issue), 404: fail('NOT_FOUND', 'gone') },
  });
  app.get('/api/issues/good', declare, (c) =>
    c.json({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z'), title: null }),
  );
  app.get('/api/issues/missing-field', declare, (c) => c.json({ id: 'a', createdAt: new Date() }));
  app.get('/api/issues/wrong-type', declare, (c) =>
    c.json({ id: 7, createdAt: new Date(), title: 't' }),
  );
  app.get('/api/issues/not-found', declare, () => {
    throw new HTTPException(404, { message: 'gone', cause: { code: 'NOT_FOUND' } });
  });
  app.get('/api/issues/other-code', declare, () => {
    throw new HTTPException(404, { message: 'gone', cause: { code: 'GONE_FOR_GOOD' } });
  });
  app.get('/api/issues/undeclared-status', declare, (c) => c.json({ id: 'a' }, 201));
  app.get(
    '/api/issues/text',
    describeOperation({ summary: 't', responses: { 200: json(z.string()) } }),
    (c) => c.text('plain'),
  );
  return app;
}

async function served() {
  const app = planted();
  const reference = await buildReference(app, { version: 't' });
  const guarded = new Hono();
  guarded.use(
    '/api/*',
    responseConformance(async () => reference),
  );
  guarded.route('/', app);
  guarded.onError(app.errorHandler);
  return guarded;
}

describe('responseConformance', () => {
  it('leaves an answer that matches its declaration as it was', async () => {
    const res = await (await served()).request('/api/issues/good');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      title: null,
    });
  });

  it('reads a Date a handler sends as the date-time string it became on the wire', async () => {
    expect((await (await served()).request('/api/issues/good')).status).toBe(200);
  });

  it('fails a body that lacks a declared field, naming the route, the status and the field', async () => {
    const res = await (await served()).request('/api/issues/missing-field');
    const body = (await res.json()) as { code: string; message: string };
    expect(res.status).toBe(500);
    expect(body.code).toBe('RESPONSE_NOT_AS_DECLARED');
    expect(body.message).toContain('GET /api/issues/missing-field');
    expect(body.message).toContain('answered 200');
    expect(body.message).toContain('title');
  });

  it('fails a field of the wrong type, naming it', async () => {
    const body = (await (await (await served()).request('/api/issues/wrong-type')).json()) as {
      message: string;
    };
    expect(body.message).toContain('id');
  });

  it('passes a declared error and fails an error code the route does not declare', async () => {
    const app = await served();
    expect((await app.request('/api/issues/not-found')).status).toBe(404);
    const other = await app.request('/api/issues/other-code');
    expect(other.status).toBe(500);
    expect(((await other.json()) as { message: string }).message).toContain('GONE_FOR_GOOD');
  });

  it('fails a success status the route does not declare', async () => {
    const res = await (await served()).request('/api/issues/undeclared-status');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toContain(
      'status 201 is not declared',
    );
  });

  it('does not read an answer that is not JSON', async () => {
    const res = await (await served()).request('/api/issues/text');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain');
  });

  it('touches nothing when switched off, so a service never pays for it', async () => {
    state.RESPONSE_CONFORMANCE = '0';
    try {
      const res = await (await served()).request('/api/issues/missing-field');
      expect(res.status).toBe(200);
    } finally {
      state.RESPONSE_CONFORMANCE = '1';
    }
  });
});

describe('judgeAnswer', () => {
  const declaration = { summary: 's', responses: { 200: json(issue) } };

  it('says a route that declares nothing is not as declared', () => {
    expect(judgeAnswer(undefined, undefined, 200, {})?.what).toContain('declares no answers');
  });

  it('accepts a status with no declared body schema', () => {
    expect(
      judgeAnswer(
        { summary: 's', responses: { 204: { kind: 'empty', description: 'd' } } },
        undefined,
        204,
        null,
      ),
    ).toBeNull();
  });

  it('names the first field that fails, by its path', () => {
    const verdict = judgeAnswer(declaration, undefined, 200, {
      id: 'a',
      createdAt: 'nope',
      title: null,
    });
    expect(verdict?.what).toContain('createdAt');
  });
});
