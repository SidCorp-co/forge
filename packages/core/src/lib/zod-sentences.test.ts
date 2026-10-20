import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schemaRefused } from './zod-sentences.js';

const body = z
  .object({
    toStatus: z.enum(['open', 'in_progress', 'awaiting_release']),
    reason: z.string().max(5).optional(),
    ids: z.array(z.string()).min(1).optional(),
  })
  .strict();

function refused(input: unknown) {
  const r = body.safeParse(input);
  if (r.success) throw new Error('expected the schema to refuse');
  const err = schemaRefused(r.error);
  const cause = err.cause as { code: string; details: Record<string, unknown> };
  return { status: err.status, message: err.message, code: cause.code, details: cause.details };
}

// ISS-1421 r14 — judge-61 read "Invalid input" from POST /transition and PATCH /batch for a status
// Forge does not have: no full stop, and nothing said what was wrong or where.
describe('schemaRefused', () => {
  it('names the field held to a fixed set, its values in details and never in the sentence', () => {
    const r = refused({ toStatus: 'shipped' });
    expect(r).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(r.message).toBe(
      'The field toStatus takes one of the values listed in details.accepted.',
    );
    expect(r.details.accepted).toEqual({ toStatus: ['open', 'in_progress', 'awaiting_release'] });
    expect(r.message).not.toMatch(/in_progress|awaiting_release|Invalid input/);
  });

  it('keeps the flattened field errors every caller already read', () => {
    const r = refused({ toStatus: 'shipped' });
    expect(r.details.fieldErrors).toHaveProperty('toStatus');
    expect(r.details.formErrors).toEqual([]);
  });

  it('says a missing field is required and an unknown one is not taken', () => {
    expect(refused({ toStatus: 'open', extra: 1 }).message).toBe(
      'The field extra is not one this call takes.',
    );
    const missing = z.object({ name: z.string() }).safeParse({});
    if (missing.success) throw new Error('expected a refusal');
    expect(schemaRefused(missing.error).message).toBe('The field name is required.');
  });

  it('words every refused field, each sentence capitalised and ending with a full stop', () => {
    const r = refused({ toStatus: 'shipped', reason: 'far too long', ids: [], extra: 1, more: 2 });
    const sentences = r.message.split(/(?<=\.) (?=[A-Z])/);
    expect(sentences.length).toBeGreaterThanOrEqual(4);
    for (const s of sentences) {
      expect(s).toMatch(/^[A-Z]/);
      expect(s).toMatch(/\.$/);
    }
    expect(r.message).toContain('The fields extra and more are not ones this call takes.');
    expect(r.message).toContain('The field reason was refused. Too big:');
  });

  it("keeps a schema's own message for a fixed-set field", () => {
    const own = z.object({ metric: z.enum(['cost'], { error: '`pass_rate` is retired' }) });
    const r = own.safeParse({ metric: 'pass_rate' });
    if (r.success) throw new Error('expected a refusal');
    expect(schemaRefused(r.error).message).toBe(
      'The field metric takes one of the values listed in details.accepted. `pass_rate` is retired.',
    );
  });

  it('opens a whole-body refusal with a capital', () => {
    const empty = z
      .object({ a: z.string().optional() })
      .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });
    const r = empty.safeParse({});
    if (r.success) throw new Error('expected a refusal');
    expect(schemaRefused(r.error).message).toBe('No fields to update.');
  });
});
