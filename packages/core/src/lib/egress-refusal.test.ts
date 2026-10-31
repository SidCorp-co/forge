import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../middleware/error.js';
import { egressAt, egressRefused, isEgressRefusal } from './data-egress.js';
import { refuser } from './refusal.js';

function app(thrown: () => Error) {
  const a = new Hono();
  a.get('/x', () => {
    throw thrown();
  });
  a.onError(errorHandler as never);
  return a;
}

type Body = { code: string; error: { code: string; refusals: { code: string }[] } };

describe('a data policy that withholds a surface', () => {
  it('is the envelope under the withholding refusal own code: CONTENT_EGRESS_FORBIDDEN, 403', async () => {
    const gate = egressAt('no_egress', 'report.exec', 'text', 'report frames');
    if (gate.ok) throw new Error('the policy should have withheld this surface');
    const res = await app(() => egressRefused(gate.refusal)).request('/x');
    expect(res.status).toBe(403);
    const body = (await res.json()) as Body;
    expect(body.error.code).toBe(gate.refusal.code);
    expect(body.error.refusals[0]?.code).toBe(gate.refusal.code);
  });

  it('is told from another module refusal', () => {
    const other = refuser<'SOMETHING_ELSE'>('SOMETHING_ELSE')('SOMETHING_ELSE', 'x');
    expect(isEgressRefusal(other)).toBe(false);
    expect(
      isEgressRefusal(
        egressRefused({ code: 'EGRESS_SURFACE_UNDECLARED', path: '', detail: 'undeclared' }),
      ),
    ).toBe(true);
    expect(isEgressRefusal(new Error('plain'))).toBe(false);
  });
});
