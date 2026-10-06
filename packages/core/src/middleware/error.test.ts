import { PROBLEM_CONTENT_TYPE } from '@forge/contracts/refusal';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refused, refuser } from '../lib/refusal.js';
import { requireAuth } from './auth.js';
import { errorHandler } from './error.js';
import type { RequestIdVars } from './request-id.js';
import { strictBody } from './zod-validator.js';

const refuse = refuser<'SESSION_CONTEXT_MISMATCH' | 'ISSUE_UPDATE_REFUSED'>('ISSUE_UPDATE_REFUSED');

function app() {
  const a = new Hono<{ Variables: RequestIdVars }>();
  a.post('/route', (c) =>
    refused(
      c,
      [{ code: 'REQUIREMENT_NOT_DRAFT', path: '/revision', detail: 'REQ-1 r1 is agreed' }],
      'REQUIREMENT_REFUSED',
    ),
  );
  a.post('/kernel', () => {
    throw refuse('SESSION_CONTEXT_MISMATCH', 'the issue moved under this write', '/sessionContext');
  });
  a.post('/schema', strictBody(z.strictObject({ title: z.string() }), '{ title: string }'), (c) =>
    c.json({}),
  );
  a.get('/auth', requireAuth(), (c) => c.json({}));
  a.onError(errorHandler);
  return a;
}

type Body = {
  type: string;
  status: number;
  detail: string;
  code: string;
  message: string;
  error: { code: string; message: string; refusals: { code: string; path: string }[] };
};

async function answer(method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return { res, body: (await res.json()) as Body };
}

/*
 * A pinned forge CLI reads `code` and `message` at the top level of the body and a newer client
 * reads `error.code`; every door answers both, and each pair agrees (RFC 9457 §3.2 extension
 * members).
 */
describe('one problem envelope at every door', () => {
  const doors = [
    ['a route returning its refusals', 'POST', '/route', undefined, 'REQUIREMENT_NOT_DRAFT'],
    ['a thrown kernel RefusalError', 'POST', '/kernel', undefined, 'SESSION_CONTEXT_MISMATCH'],
    ['a zod schema refusal', 'POST', '/schema', { title: 1 }, 'BAD_REQUEST'],
    ['an auth refusal', 'GET', '/auth', undefined, 'UNAUTHENTICATED'],
  ] as const;

  for (const [door, method, path, sent, code] of doors) {
    it(`${door} carries the code and message at the top level and under error`, async () => {
      const { res, body } = await answer(method, path, sent);
      expect(res.headers.get('Content-Type')).toBe(PROBLEM_CONTENT_TYPE);
      expect(body.status).toBe(res.status);
      expect(body.type).toBe(`urn:forge:refusal:${code}`);
      expect(body.code, 'top-level code, read by pinned clients').toBe(code);
      expect(body.error?.code, 'error.code').toBe(code);
      expect(typeof body.message, 'top-level message').toBe('string');
      expect(body.message).toBe(body.error.message);
      expect(body.error.refusals.length).toBeGreaterThan(0);
    });
  }

  it("a refusal's message names each refusal's code, path and detail", async () => {
    const { body } = await answer('POST', '/kernel');
    expect(body.message).toBe(
      'refused, nothing written: SESSION_CONTEXT_MISMATCH at /sessionContext: the issue moved under this write',
    );
  });

  it("a schema refusal's message names the failing field", async () => {
    const { res, body } = await answer('POST', '/schema', { title: 1 });
    expect(res.status).toBe(400);
    expect(body.error.refusals[0]?.path).toBe('/title');
    expect(body.message).toContain('BAD_REQUEST at /title: ');
  });

  it('an auth refusal is one refusal at the request, its message the sentence', async () => {
    const { res, body } = await answer('GET', '/auth');
    expect(res.status).toBe(401);
    expect(body.message).toBe('authentication required');
    expect(body.error.refusals).toEqual([
      { code: 'UNAUTHENTICATED', path: '', detail: 'authentication required' },
    ]);
  });
});
