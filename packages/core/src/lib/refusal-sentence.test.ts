import { describe, expect, it } from 'vitest';
import {
  isRefusalSentence,
  refusalBody,
  refusalMessage,
  refusalSentence,
} from './refusal-sentence.js';

// ISS-1421 r14 — the REST envelope and the MCP tool-error wrapper read every refusal through here.
describe('refusalSentence', () => {
  it('capitalises a lower-case opening and ends the sentence', () => {
    expect(refusalSentence('invalid project id')).toBe('Invalid project id.');
    expect(refusalSentence('file too large.')).toBe('File too large.');
  });

  it('quotes an opening that names a field rather than capitalising it', () => {
    expect(refusalSentence('projectId is required')).toBe('`projectId` is required.');
    expect(refusalSentence('release_chain: not an array')).toBe('`release_chain`: not an array.');
  });

  it('keeps leading codes and every line after the first as written', () => {
    expect(refusalSentence('BAD_REQUEST: CONFLICT: issue moved\n`a` takes: "x"')).toBe(
      'BAD_REQUEST: CONFLICT: Issue moved.\n`a` takes: "x"',
    );
  });

  it('leaves a sentence alone', () => {
    const said = 'Project "Storefront" has no live deploy target.';
    expect(refusalSentence(said)).toBe(said);
    expect(isRefusalSentence(said)).toBe(true);
  });

  it('does not count "Invalid input", a lower-case opening or a missing full stop as a sentence', () => {
    expect(isRefusalSentence('Invalid input.')).toBe(false);
    expect(isRefusalSentence('missing thing.')).toBe(false);
    expect(isRefusalSentence('Missing thing')).toBe(false);
    expect(isRefusalSentence('NOT_FOUND: issue ISS-1')).toBe(false);
  });
});

describe('refusalMessage', () => {
  it('replaces "Invalid input" over flattened errors with a sentence per field', () => {
    expect(
      refusalMessage('Invalid input', {
        formErrors: [],
        fieldErrors: { limit: ['Too big: expected number to be <=100'], id: ['Invalid UUID'] },
      }),
    ).toBe('The field limit takes at most 100. The field id is not a valid UUID.');
  });

  it('says the input was refused when "Invalid input" carries nothing to name', () => {
    expect(refusalMessage('Invalid input', undefined)).toBe('The input was refused.');
  });

  // ISS-1421 r16 — judge-69 read "The input was refused." with the reason beside it in details.
  it('says the reason a door handed as a sentence, never the generic refusal', () => {
    expect(refusalMessage('Invalid input', 'projectId is required unless scope=all')).toBe(
      '`projectId` is required unless scope=all.',
    );
    expect(
      refusalMessage(
        'Invalid input',
        'Forge cannot deploy to `postman` — it has no deploy adapter, so this binding can only be `role: "service"`.',
      ),
    ).toMatch(/^Forge cannot deploy to `postman`/);
    expect(refusalMessage('Invalid input', ['a is wrong', 'b is wrong'])).toBe(
      'A is wrong. B is wrong.',
    );
    expect(refusalMessage('Invalid input', { message: 'prompt is required' })).toBe(
      'Prompt is required.',
    );
    expect(refusalMessage('Invalid input', { projectId: 'is required unless scope=all' })).toBe(
      'The field projectId is required unless scope=all.',
    );
    expect(refusalMessage('Invalid input', { config: { url: 'required' } })).toBe(
      'The field config.url is required.',
    );
    expect(
      refusalMessage('Invalid input', [
        { message: 'Invalid input: expected string, received undefined', path: ['id'] },
      ]),
    ).toBe('The field id is required.');
  });

  it('keeps the generic refusal for details that hold no reason', () => {
    expect(refusalMessage('Invalid input', { count: 3 })).toBe('The input was refused.');
    expect(refusalMessage('', null)).toBe('The request was refused.');
  });

  it('makes any other message a sentence', () => {
    expect(refusalMessage('verify email', undefined)).toBe('Verify email.');
  });
});

// ISS-1421 r18 — "Invalid params." and "Invalid query." stood where the details named the field.
describe('a refusal that only labels what it refused', () => {
  const flattened = { formErrors: [], fieldErrors: { id: ['Invalid UUID'] } };

  it('says the field its schema details name instead', () => {
    expect(refusalMessage('invalid params', flattened)).toBe('The field id is not a valid UUID.');
    expect(refusalMessage('invalid query', flattened)).toBe('The field id is not a valid UUID.');
  });

  it('keeps its own words where the details are no schema parse', () => {
    expect(refusalMessage('invalid', { field: 'email' })).toBe('Invalid.');
  });

  it('keeps a sentence a door wrote whatever its details say', () => {
    expect(refusalMessage('That label is taken.', flattened)).toBe('That label is taken.');
  });
});

// ISS-1421 r21 — judge-89: a handler's own reason kept {"code":"required"} in details beside a
// message saying "The field code is required.", in no shape a schema refusal's details take.
describe('refusalBody', () => {
  const said = (details: unknown) => refusalBody('Invalid input', details);

  it('keeps details already keyed as `{ formErrors }` alone, rather than naming a field formErrors', () => {
    const body = said({ formErrors: ['ISS-1185 needs ?projectId= to name its project.'] });
    expect(body.details).toEqual({
      formErrors: ['ISS-1185 needs ?projectId= to name its project.'],
      fieldErrors: {},
    });
    expect(body.message).toContain('?projectId=');
  });

  it('keys a record of field to words as a schema refusal, each sentence the message says', () => {
    const body = said({ code: 'required', state: 'required' });
    expect(body).toEqual({
      message: 'The field code is required. The field state is required.',
      details: {
        formErrors: [],
        fieldErrors: {
          code: ['The field code is required.'],
          state: ['The field state is required.'],
        },
      },
    });
  });

  it('names a nested field by its whole path and a list by each of its words', () => {
    expect(said({ config: { url: 'required' }, textContent: ['is empty'] })).toEqual({
      message: 'The field config.url is required. The field textContent is empty.',
      details: {
        formErrors: [],
        fieldErrors: {
          'config.url': ['The field config.url is required.'],
          textContent: ['The field textContent is empty.'],
        },
      },
    });
  });

  it("keeps a sentence, a list of them or a lone message as the input's own", () => {
    expect(said('projectId is required unless scope=all')).toEqual({
      message: '`projectId` is required unless scope=all.',
      details: { formErrors: ['`projectId` is required unless scope=all.'], fieldErrors: {} },
    });
    expect(said({ message: 'an issue cannot depend on itself' }).details).toEqual({
      formErrors: ['An issue cannot depend on itself.'],
      fieldErrors: {},
    });
    expect(said(['a is wrong', 'b is wrong']).details).toEqual({
      formErrors: ['A is wrong.', 'B is wrong.'],
      fieldErrors: {},
    });
  });

  it("quotes a number field's value from what was sent", () => {
    const body = refusalBody(
      'Invalid input',
      { limit: 'Invalid input: expected number, received NaN' },
      (f) => (f === 'limit' ? 'abc' : undefined),
    );
    expect(body.details).toEqual({
      formErrors: [],
      fieldErrors: { limit: ['The field limit takes a number, not "abc".'] },
    });
    expect(body.message).toBe('The field limit takes a number, not "abc".');
  });

  it("leaves data a door attached, and a door's own message, as they were", () => {
    expect(said({ count: 3 })).toEqual({
      message: 'The input was refused.',
      details: { count: 3 },
    });
    const own = refusalBody('That label is taken.', { label: 'taken' });
    expect(own).toEqual({ message: 'That label is taken.', details: { label: 'taken' } });
  });
});
