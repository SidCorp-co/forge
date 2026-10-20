import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ValidatorDeclaration,
  validatorDeclarations,
  zValidator,
} from '../declare/validator.js';
import { probeInputRefusal } from './probe-hook.js';

function declared(hook?: Parameters<typeof zValidator>[2]): ValidatorDeclaration {
  const middleware = zValidator('json', z.object({ a: z.string() }), hook);
  const declaration = validatorDeclarations.get(middleware);
  if (!declaration) throw new Error('the validator recorded nothing');
  return declaration;
}

describe('probeInputRefusal', () => {
  it('reads the status and code of the exception a hook throws', async () => {
    const refusal = await probeInputRefusal(
      declared((r) => {
        if (!r.success) throw new HTTPException(422, { message: 'x', cause: { code: 'TOO_LONG' } });
      }),
    );
    expect(refusal).toEqual({ kind: 'refused', status: 422, code: 'TOO_LONG' });
  });

  it('derives the code from the status where the exception names none', async () => {
    const refusal = await probeInputRefusal(
      declared((r) => {
        if (!r.success) throw new HTTPException(400, { message: 'x' });
      }),
    );
    expect(refusal).toEqual({ kind: 'refused', status: 400, code: 'BAD_REQUEST' });
  });

  it('reads the status and code of a response a hook returns', async () => {
    const refusal = await probeInputRefusal(
      declared((r, c) => {
        if (!r.success) return c.json({ code: 'NOPE', message: 'm' }, 409);
      }),
    );
    expect(refusal).toEqual({ kind: 'refused', status: 409, code: 'NOPE' });
  });

  it('passes the hook a ZodError it can flatten, as it would meet on a real refusal', async () => {
    const refusal = await probeInputRefusal(
      declared((r) => {
        if (!r.success) {
          const flat = z.flattenError(r.error as z.core.$ZodError<unknown>);
          throw new HTTPException(400, {
            message: 'x',
            cause: { code: Object.keys(flat.fieldErrors).join(',') || 'FLAT' },
          });
        }
      }),
    );
    expect(refusal).toMatchObject({ kind: 'refused', status: 400 });
  });

  it('reads a refusal in the envelope for a validator given no hook (ISS-1421 r14)', async () => {
    expect(await probeInputRefusal(declared())).toEqual({
      kind: 'refused',
      status: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('reads a refusal in the envelope for a hook that lets a failed parse through', async () => {
    expect(await probeInputRefusal(declared(() => undefined))).toEqual({
      kind: 'refused',
      status: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('says it could not read a hook that fails some other way, never that the hook is silent', async () => {
    const refusal = await probeInputRefusal(
      declared(() => {
        throw new TypeError('reads a thing the probe cannot give');
      }),
    );
    expect(refusal).toEqual({ kind: 'unreadable', why: 'reads a thing the probe cannot give' });
  });
});
