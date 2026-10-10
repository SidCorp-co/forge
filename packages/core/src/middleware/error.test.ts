import { criterionProbeSchema } from '@forge/contracts/criterion-probes';
import { PROBLEM_CONTENT_TYPE } from '@forge/contracts/refusal';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { refused, refuser } from '../lib/refusal.js';
import { requireAuth } from './auth.js';
import { errorHandler } from './error.js';
import type { RequestIdVars } from './request-id.js';
import { nestedFieldShape, strictBody, zValidator } from './zod-validator.js';

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

/**
 * ISS-469: a malformed probe was answered with every fault under `error.refusals`, but the answer's
 * own `detail` named the first only ("(1 more under error.refusals)"), the shape repeated after
 * it (judge J1 on 0.4.0-dev.222: no `argv` and a string `exitCode` named only `argv`). One refusal
 * now says every fault at its path, then the shape once.
 */
describe('a structured field with several faults', () => {
  const SHAPE = '{ kind: "command", command: { argv: [program, …args] }, expect: { exitCode } }';
  function probeApp() {
    const a = new Hono<{ Variables: RequestIdVars }>();
    a.post(
      '/verdicts',
      zValidator(
        'json',
        z.strictObject({ criterion: z.number(), probe: criterionProbeSchema.optional() }),
        nestedFieldShape('probe', 'VERDICT_PROBE_SHAPE', SHAPE),
      ),
      (c) => c.json({}),
    );
    a.onError(errorHandler);
    return a;
  }
  const send = async (body: unknown) => {
    const res = await probeApp().request('/verdicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };

  it('names every fault at its path in the one detail, and the shape once', async () => {
    const { status, body } = await send({
      criterion: 1,
      probe: { kind: 'command', command: {}, expect: { exitCode: 'zero' } },
    });
    expect(status).toBe(422);
    expect(body.error.refusals.map((r) => r.path)).toEqual([
      '/probe/command/argv',
      '/probe/expect/exitCode',
    ]);
    expect(body.detail).toContain('/probe/command/argv');
    expect(body.detail).toContain('/probe/expect/exitCode');
    expect(body.detail).not.toContain('more under error.refusals');
    expect(body.detail.split(SHAPE)).toHaveLength(2);
  });

  it('names a fault outside the field in the same detail', async () => {
    const { body } = await send({
      criterion: 'one',
      probe: { kind: 'command', command: {}, expect: { exitCode: 0 } },
    });
    expect(body.error.refusals.map((r) => [r.code, r.path])).toEqual([
      ['BAD_REQUEST', '/criterion'],
      ['VERDICT_PROBE_SHAPE', '/probe/command/argv'],
    ]);
    expect(body.detail).toContain('/criterion');
    expect(body.detail).toContain('/probe/command/argv');
  });

  it('keeps a lone fault said once, with the shape', async () => {
    const { body } = await send({
      criterion: 1,
      probe: { kind: 'command', command: {}, expect: { exitCode: 0 } },
    });
    expect(body.error.refusals).toHaveLength(1);
    expect(body.detail).toContain('/probe/command/argv');
    expect(body.detail.split(SHAPE)).toHaveLength(2);
  });
});
