import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeAll, describe, expect, it } from 'vitest';
import { isRefusalSentence } from '../../lib/refusal-sentence.js';
import { errorHandler } from '../../middleware/error.js';
import type { RequestIdVars } from '../../middleware/request-id.js';
import type { ValidatorDeclaration } from '../declare/validator.js';
import { type RouteEntry, type RouteSource, readRoutes } from '../document/registry.js';

/**
 * ISS-1421 r14 — every input refusal of the composed app reads as a sentence. Each route's own
 * validator hook is run, in a real Hono context and through the app's own error handler, on an
 * input its schema refuses; the message must open on no lower-case letter, end with a full stop
 * and never be zod's "Invalid input". judge-61 read "Invalid input" from the status move, and the
 * same words stood on several hundred other doors.
 */

/** Inputs tried in turn until the route's schema refuses one; a schema that takes them all is skipped. */
const BODIES: readonly unknown[] = [{}, { __probe__: 1 }, 'x', 42, []];
const RECORDS: readonly unknown[] = [{}, { __probe__: 'x' }];

let routes: RouteEntry[];

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: RouteSource };
  routes = readRoutes(app);
}, 120_000);

type Answer = { status: number; message: unknown } | 'accepted';

async function refusalOf(declaration: ValidatorDeclaration): Promise<Answer> {
  const inputs = declaration.target === 'json' ? BODIES : RECORDS;
  for (const input of inputs) {
    const result = await declaration.schema.safeParseAsync(input);
    if (result.success) continue;
    const hook = declaration.hook as (r: unknown, c: unknown) => unknown;
    const mini = new Hono<{ Variables: RequestIdVars }>();
    mini.onError(errorHandler);
    mini.all('*', async (c) => {
      const answered = await hook({ ...result, data: input, target: declaration.target }, c);
      if (answered instanceof Response) return answered;
      return c.json({ passed: true });
    });
    const res = await mini.request('/probe', { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return { status: res.status, message: body.message };
  }
  return 'accepted';
}

describe('the input refusals of the composed app', () => {
  it('read as sentences on every route that validates its input', async () => {
    const wrong: string[] = [];
    let refused = 0;
    for (const entry of routes) {
      for (const declaration of entry.validators) {
        if (declaration.enforced === false || declaration.hook === null) continue;
        const answer = await refusalOf(declaration);
        if (answer === 'accepted') continue;
        refused++;
        const { status, message } = answer;
        if (status < 400 || status >= 500)
          wrong.push(`${entry.key} [${declaration.target}] answered ${status} to a refused input`);
        else if (typeof message !== 'string' || !isRefusalSentence(message))
          wrong.push(`${entry.key} [${declaration.target}] ${status}: ${JSON.stringify(message)}`);
      }
    }
    // The walk is not vacuous: the composed app validates the input of several hundred routes.
    expect(refused).toBeGreaterThan(300);
    expect(wrong, 'each line is a route whose input refusal is not a sentence').toEqual([]);
  }, 120_000);
});

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const WRITTEN =
  /new HTTPException\(\s*(4\d\d)\s*,\s*\{\s*message:\s*(['"`])((?:\\.|(?!\2).)*?)\2/gs;

/** Every 4xx refusal written as `new HTTPException(4xx, { message: '…' })` under `src`. */
function writtenRefusals(): { file: string; status: number; said: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('.fixture.'))
    .flatMap((file) =>
      [...readFileSync(join(SRC, file), 'utf8').matchAll(WRITTEN)]
        .filter((m) => !(m[3] ?? '').startsWith('${'))
        .map((m) => ({
          file,
          status: Number(m[1]),
          said: (m[3] ?? '').replace(/\$\{[^}]*\}/g, 'X1'),
        })),
    );
}

describe('every 4xx refusal written under src, as the error envelope answers it', () => {
  it('is a sentence', async () => {
    const written = writtenRefusals();
    expect(written.length).toBeGreaterThan(250);
    const wrong: string[] = [];
    for (const { file, status, said } of written) {
      const mini = new Hono<{ Variables: RequestIdVars }>();
      mini.onError(errorHandler);
      mini.all('*', () => {
        throw new HTTPException(status as 400, { message: said });
      });
      const body = (await (await mini.request('/probe')).json()) as { message?: unknown };
      if (typeof body.message !== 'string' || !isRefusalSentence(body.message))
        wrong.push(`${file} ${status}: ${JSON.stringify(body.message)}`);
    }
    expect(
      wrong,
      'each line is a written refusal the envelope does not answer as a sentence',
    ).toEqual([]);
  }, 120_000);
});
