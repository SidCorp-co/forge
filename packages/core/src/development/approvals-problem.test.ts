import { approvalItemSchema } from '@forge/contracts/approvals';
import { describe, expect, it } from 'vitest';
import { problemOf } from './approvals-problem.js';

const row = {
  kind: 'suggestion',
  id: 'suggestion:1',
  key: 'ISS-1',
  title: 'Route payments',
  suggestionKind: 'triage',
  mockupKind: null,
  revision: null,
  askedBy: { kind: 'person', name: 'Ann' },
  since: null,
  opens: { kind: 'issue', key: 'ISS-1' },
  approve: null,
  decline: null,
};

const problem = (input: unknown) => {
  const r = approvalItemSchema.safeParse(input);
  if (r.success) throw new Error('the row parsed');
  return problemOf(r.error.issues);
};

describe('why a record could not be made a row, as the inbox says it', () => {
  it('names an over-long asker in words, never the schema path or zod wording', () => {
    const said = problem({ ...row, askedBy: { kind: 'person', name: 'n'.repeat(201) } });
    expect(said).toBe("the asker's name is longer than 200 characters");
    expect(said).not.toMatch(/askedBy|Too big|<=/);
  });

  it('says an empty key is empty', () => {
    expect(problem({ ...row, opens: { kind: 'issue', key: '' } })).toBe(
      'the key of the page it opens is empty',
    );
  });

  it('keeps a refinement its own sentence', () => {
    expect(problem({ ...row, opens: null })).toBe(
      'an approval row is decided here or opens the page that decides it, never neither',
    );
  });

  it('names a field it has no word for by its path, and joins several', () => {
    expect(
      problemOf([
        { code: 'invalid_value', path: ['nested', 'x'], message: 'bad' },
        { code: 'too_big', path: [], message: 'big', maximum: 3, origin: 'array' },
      ]),
    ).toBe('the field nested.x: bad; the row is over its limit of 3');
  });
});
