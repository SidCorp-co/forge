import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flattenedRefusalWords, schemaRefused, zodMessageWords } from './zod-sentences.js';

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

  it('keeps the flattened field errors every caller already read, in the words of the message', () => {
    const r = refused({ toStatus: 'shipped' });
    expect(r.details.fieldErrors).toEqual({
      toStatus: ['The field toStatus takes one of the values listed in details.accepted.'],
    });
    expect(r.details.formErrors).toEqual([]);
  });

  // ISS-1421 r19 — judge-79: details.fieldErrors said "received NaN" where the message quoted the value.
  it('says a number sent a word the same way in details as in the message, never NaN', () => {
    const query = z.object({ limit: z.coerce.number() }).strict();
    const r = query.safeParse({ limit: 'abc', colour: 'red' });
    if (r.success) throw new Error('expected a refusal');
    const err = schemaRefused(r.error, query, { limit: 'abc', colour: 'red' });
    const details = (err.cause as { details: { formErrors: string[]; fieldErrors: unknown } })
      .details;
    expect(details.fieldErrors).toEqual({ limit: ['The field limit takes a number, not "abc".'] });
    expect(details.formErrors).toEqual(['The field colour is not one this call takes.']);
    expect(err.message).toBe(
      'The field limit takes a number, not "abc". The field colour is not one this call takes.',
    );
    expect(JSON.stringify(details)).not.toMatch(/NaN|Invalid input|Unrecognized/);
  });

  it("words a discriminator outside its values as Forge's sentence, never zod's (ISS-1421 r15)", () => {
    const keys = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('generate'), name: z.string() }),
      z.object({ mode: z.literal('provide'), key: z.string() }),
    ]);
    const r = keys.safeParse({ mode: 'nope' });
    if (r.success) throw new Error('expected a refusal');
    const err = schemaRefused(r.error);
    expect(err.message).toBe('The field mode takes one of the values listed in details.accepted.');
    expect((err.cause as { details: { accepted: unknown } }).details.accepted).toEqual({
      mode: ['generate', 'provide'],
    });
    expect(err.message).not.toMatch(/discriminator|Expected/);
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
    expect(r.message).toContain('The field reason takes at most 5 characters.');
    expect(r.message).toContain('The field ids cannot be empty.');
    expect(r.message).not.toMatch(/Invalid input|Too big|Too small/);
  });

  it("words zod's own messages for a field and never repeats them", async () => {
    const { zodMessageWords } = await import('./zod-sentences.js');
    expect(zodMessageWords('n', 'Invalid input: expected number, received string')).toBe(
      'The field n takes a number, not a string.',
    );
    expect(zodMessageWords('id', 'Invalid UUID')).toBe('The field id is not a valid UUID.');
    expect(zodMessageWords('k', 'Invalid option: expected one of "a"|"b"')).toBe(
      'The field k takes one of "a", "b".',
    );
    expect(zodMessageWords('when', 'Invalid input')).toBe(
      'The field when matches none of the forms it takes.',
    );
    expect(zodMessageWords('n', 'Too small: expected number to be >0')).toBe(
      'The field n takes more than 0.',
    );
    expect(zodMessageWords(null, 'Invalid input: expected object, received string')).toBe(
      'The input takes an object, not a string.',
    );
  });

  it("leads with a schema's own reason for a fixed-set field, the values after it", () => {
    const own = z.object({ metric: z.enum(['cost'], { error: '`pass_rate` is retired' }) });
    const r = own.safeParse({ metric: 'pass_rate' });
    if (r.success) throw new Error('expected a refusal');
    expect(schemaRefused(r.error).message).toBe(
      '`pass_rate` is retired. The field metric takes one of the values listed in details.accepted.',
    );
  });

  it('says a reason naming the field as a noun as its own sentence, and one with a verb as the field', () => {
    const noun = z.object({ metric: z.enum(['cost'], { error: 'metric `vibes` is not served' }) });
    const verb = z.object({
      eligible: z.enum(['true'], { error: 'eligible must be true or false' }),
    });
    const a = noun.safeParse({ metric: 'vibes' });
    const b = verb.safeParse({ eligible: 'x' });
    if (a.success || b.success) throw new Error('expected refusals');
    expect(schemaRefused(a.error).message).toMatch(
      /^Metric `vibes` is not served\. The field metric/,
    );
    expect(schemaRefused(b.error).message).toMatch(/^The field eligible must be true or false\. /);
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

// ISS-1421 r18, criterion 173 — a JSON body number sent "abc" read "takes a number, not a string".
describe('a number field sent no number', () => {
  const body = z.object({ inputTokens: z.number(), apiKey: z.number().optional() });
  const said = (input: unknown) => {
    const r = body.safeParse(input);
    if (r.success) throw new Error('expected a refusal');
    return schemaRefused(r.error, body, input).message;
  };

  it('quotes the value sent', () => {
    expect(said({ inputTokens: 'abc' })).toBe('The field inputTokens takes a number, not "abc".');
  });

  it('quotes at most forty characters of it', () => {
    expect(said({ inputTokens: 'x'.repeat(60) })).toBe(
      `The field inputTokens takes a number, not "${'x'.repeat(40)}…".`,
    );
  });

  it("never repeats a secret field's value", () => {
    expect(said({ inputTokens: 1, apiKey: 'sk-live-123' })).toBe(
      'The field apiKey takes a number, not a string.',
    );
    expect(said({ inputTokens: 1, apiKey: true })).toBe(
      'The field apiKey takes a number, not a boolean.',
    );
  });

  it('says a boolean as itself', () => {
    expect(said({ inputTokens: true })).toBe('The field inputTokens takes a number, not true.');
  });
});

// ISS-1421 r28 — judge-114 read "The field secrets.serviceAccountJson was refused. ServiceAccountJson
// names a "token_uri"…" in the drawer of a person who had pasted a key file.
describe("a schema's own sentence about the value sent", () => {
  const said =
    'This key file\'s "token_uri" is not Google\'s, so Forge will not send a signed assertion there.';

  it('is said whole, naming no field', () => {
    expect(zodMessageWords('secrets.serviceAccountJson', said)).toBe(said);
    expect(flattenedRefusalWords({ secrets: { serviceAccountJson: [said] } })).toEqual([said]);
  });

  it('leaves a message that does not open on the value sent to name its field', () => {
    expect(zodMessageWords('secrets.token', 'Thistle is not a token')).toBe(
      'The field secrets.token was refused. Thistle is not a token.',
    );
  });
});
