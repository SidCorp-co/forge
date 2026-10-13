import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { statusToCode } from '../middleware/error.js';
import type { ValidatorDeclaration } from './validator.js';

/** What a route answers when its input fails the schema it declares. */
export type InputRefusal =
  | { readonly kind: 'refused'; readonly status: number; readonly code: string }
  /** No hook: the library answers 400 with the failed parse as the body. */
  | { readonly kind: 'library-default' }
  | { readonly kind: 'unreadable'; readonly why: string };

/**
 * A context a validation hook can run against: every request read answers empty, and `json`
 * builds the response the hook would have sent. It is only for reading what a hook refuses with.
 */
function probeContext(): unknown {
  const noop = () => undefined;
  const req = new Proxy(
    { path: '/probe', method: 'GET', param: () => '', query: () => undefined },
    { get: (target, key) => (key in target ? (target as never)[key] : noop) },
  );
  return new Proxy(
    {
      req,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    },
    { get: (target, key) => (key in target ? (target as never)[key] : noop) },
  );
}

/**
 * Runs a validator's own hook on a failed parse and reads what it refuses with, so the reference
 * states the status and code the route sends and not the one a document beside it would claim.
 */
export async function probeInputRefusal(declaration: ValidatorDeclaration): Promise<InputRefusal> {
  if (declaration.hook === null) return { kind: 'library-default' };
  const error = new z.ZodError([
    { code: 'custom', message: 'probe', path: ['probe'], input: undefined },
  ]);
  const failed = { success: false, error, data: {}, target: declaration.target };
  try {
    const hook = declaration.hook as (result: unknown, c: unknown) => unknown;
    const answered = await hook(failed, probeContext());
    if (answered instanceof Response) return await readResponse(answered);
    return { kind: 'library-default' };
  } catch (thrown) {
    if (thrown instanceof HTTPException) {
      const cause = thrown.cause as { code?: unknown } | undefined;
      const code = typeof cause?.code === 'string' ? cause.code : statusToCode(thrown.status);
      return { kind: 'refused', status: thrown.status, code };
    }
    return {
      kind: 'unreadable',
      why: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

async function readResponse(response: Response): Promise<InputRefusal> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : statusToCode(response.status);
  return { kind: 'refused', status: response.status, code };
}
