import { readFileSync } from 'node:fs';
import { scrubLogText } from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { criteriaFromDocument, DOCUMENT_CRITERIA_MAX } from './document-criteria.js';

const SPEC = readFileSync(
  new URL('../../tests/fixtures/documents/criteria-120.md', import.meta.url),
  'utf8',
);
const ITEM = /^(?:- \[ \] |- |\d+\. )/;
/** The criteria as the file states them: each item line with its marker taken off and nothing else. */
const STATED = SPEC.split('\n')
  .slice(
    SPEC.split('\n').indexOf('## Acceptance criteria') + 1,
    SPEC.split('\n').indexOf('## Out of scope'),
  )
  .filter((l) => ITEM.test(l))
  .map((l) => l.replace(ITEM, ''));

describe('criteria taken from a document', () => {
  it('holds every one of the 120 lines of the criteria section, each exactly as written', () => {
    expect(STATED).toHaveLength(120);
    const taken = criteriaFromDocument(scrubLogText(SPEC), {
      file: 'criteria-120.md',
      section: 'Acceptance criteria',
    });
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    if (!taken.ok) return;
    expect(taken.criteria.map((c) => c.body)).toEqual(STATED);
    expect(taken.criteria[0]?.line).toBe(7);
    expect(taken.criteria[119]?.line).toBe(126);
  });

  it('takes a file that is only a list whole, skipping its heading and blank lines', () => {
    const list = ['# Criteria', '', ...STATED.map((s) => `- ${s}`), ''].join('\n');
    const taken = criteriaFromDocument(list, { file: 'list.md' });
    expect(taken.ok && taken.criteria.map((c) => c.body)).toEqual(STATED);
  });

  it('refuses the whole file by the number of its first line that is not a list item', () => {
    const taken = criteriaFromDocument(SPEC, { file: 'criteria-120.md' });
    expect(taken).toMatchObject({ ok: false, line: 3 });
    expect(!taken.ok && taken.detail).toContain('line 3 of criteria-120.md');
    expect(!taken.ok && taken.detail).toContain('is not a list item');
  });

  it('refuses a criterion that runs onto a second line, naming that line', () => {
    const lines = STATED.map((s) => `- ${s}`);
    lines.splice(56, 0, '  which the owner added as a second line');
    const taken = criteriaFromDocument(lines.join('\n'), { file: 'spec.md' });
    expect(taken).toMatchObject({ ok: false, line: 57 });
    expect(!taken.ok && taken.detail).toContain('line 57 of spec.md ("which the owner added');
  });

  it('refuses a nested item rather than flattening it into a criterion of its own', () => {
    const taken = criteriaFromDocument('- The list pages.\n  - by 25 rows\n', { file: 'n.md' });
    expect(taken).toMatchObject({ ok: false, line: 2 });
    expect(!taken.ok && taken.detail).toContain('nested under the item above it');
  });

  it('refuses a line the scrubber redacted, since the criterion would not be the line as written', () => {
    const text = scrubLogText(
      '- The page loads.\n- Sign in with api_key: sk-live-0123456789abcdef works.\n',
    );
    const taken = criteriaFromDocument(text, { file: 's.md' });
    expect(taken).toMatchObject({ ok: false, line: 2 });
    expect(!taken.ok && taken.detail).toContain('redacted');
  });

  it(`refuses the item past the ${DOCUMENT_CRITERIA_MAX} a revision holds, by its line`, () => {
    const many = Array.from(
      { length: DOCUMENT_CRITERIA_MAX + 1 },
      (_, i) => `- Criterion ${i + 1}.`,
    );
    const taken = criteriaFromDocument(many.join('\n'), { file: 'm.md' });
    expect(taken).toMatchObject({ ok: false, line: DOCUMENT_CRITERIA_MAX + 1 });
  });

  it('refuses a section the file does not have, naming the headings it does', () => {
    const taken = criteriaFromDocument(SPEC, { file: 'criteria-120.md', section: 'Criteria' });
    expect(taken).toMatchObject({ ok: false, line: null });
    expect(!taken.ok && taken.detail).toContain('"Acceptance criteria"');
  });

  it('refuses a document with no list in it', () => {
    const taken = criteriaFromDocument('# Notes\n\n', { file: 'notes.md' });
    expect(taken).toMatchObject({ ok: false, line: null });
  });
});
