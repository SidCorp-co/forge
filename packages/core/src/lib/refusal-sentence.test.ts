import { describe, expect, it } from 'vitest';
import { isRefusalSentence, refusalMessage, refusalSentence } from './refusal-sentence.js';

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

  it('makes any other message a sentence', () => {
    expect(refusalMessage('verify email', undefined)).toBe('Verify email.');
  });
});
