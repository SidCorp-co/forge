import { describe, expect, it } from 'vitest';
import corpus from './comment-corpus.json' with { type: 'json' };
import { extractStatusAssertions } from './status-assertions.js';

const read = (text: string) =>
  extractStatusAssertions(text, ['ISS']).map((a) => `${a.seq}:${a.claim}`);

/** Every positive fixture below is a line from this project's own comment history. */
const quoted = (needle: string): string => {
  const row = corpus.rows.find((r) => r.body.includes(needle));
  if (!row) throw new Error(`no comment in the export contains ${JSON.stringify(needle)}`);
  return row.body;
};

describe('the shapes an agent on this project actually writes a status in', () => {
  it('reads a plain past tense', () => {
    expect(read(quoted('ISS-992 merged at 5fce89c6'))).toContain('992:merged');
  });

  it('reads a passive', () => {
    expect(read(quoted('ISS-977 was squash-merged'))).toContain('977:merged');
  });

  it('reads a present perfect', () => {
    expect(read('ISS-996 has been merged to main.')).toContain('996:merged');
  });

  it('reads a copula with a status adjective', () => {
    expect(read(quoted('ISS-996 is closed and stays closed'))).toContain('996:closed');
  });

  it('reads the status word ahead of the reference', () => {
    expect(read(quoted('Merged ISS-807 to main'))).toContain('807:merged');
  });

  it('reads a parenthetical', () => {
    expect(read(quoted("ISS-949's rollup, merged 21:49Z"))).toContain('949:merged');
  });
});

describe('what it refuses to read as an assertion', () => {
  it.each([
    ['a negation', 'ISS-996 is not merged yet.'],
    ['a syntactic condition', 'ISS-996 will be merged once CI passes.'],
    ['a question', 'Is ISS-996 merged?'],
    ['another speaker', 'The reviewer said ISS-996 is merged.'],
    ['a modal', 'ISS-996 might be merged by now.'],
    ['an expression of uncertainty', 'Whether ISS-996 is merged is the open question'],
    ['a quoted block', '> ISS-996 is merged.'],
    ['inline code', '`ISS-996 is merged` in the log line'],
    ['a reversal', 'ISS-996 was merged, then rolled back.'],
    [
      'the word used as an adjective',
      'telling it to take the issue to landed code, naming ISS-984',
    ],
    ['a hyphenated compound', 'ISS-996 adds a closed-loop check.'],
    ['a hyphenated compound before the reference', 'The merged-comment door refuses ISS-996.'],
    ['a closed-source dependency', 'ISS-996 is about a closed-source dependency.'],
    ['a hyphen on the other side', 'ISS-996 landed-on nothing yet.'],
    ['a shipped-artifact compound', 'ISS-996 names the shipped-artifact path.'],
    ['a landed-cost compound', 'ISS-996 reports the landed-cost figure.'],
  ])('abstains on %s', (_kind, text) => {
    expect(read(text)).toEqual([]);
  });

  it('is not fooled by a claim about something other than the issue', () => {
    expect(
      read(quoted('ISS-587/589/649 are epics whose every child is closed and merged')),
    ).toEqual([]);
  });
});

describe('binding', () => {
  it('judges two references in one comment against their own clauses', () => {
    expect(read('ISS-996 is merged and ISS-997 is closed.')).toEqual(['996:merged', '997:closed']);
  });

  it('keeps the assertion and drops the denial when a sentence carries both', () => {
    expect(read('ISS-996 is merged but ISS-997 is not.')).toEqual(['996:merged']);
  });
});

describe('the export the positive corpus is drawn from', () => {
  it('records where every row came from', () => {
    expect(corpus.rows.length).toBeGreaterThan(50);
    for (const row of corpus.rows) {
      expect(row.commentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(row.body.length).toBeGreaterThan(24);
    }
  });

  it('holds enough real assertions that abstaining on everything cannot pass', () => {
    expect(corpus.rows.filter((r) => r.asserts.length > 0).length).toBeGreaterThanOrEqual(25);
  });

  it('recognises every assertion the export is labelled with', () => {
    for (const row of corpus.rows) {
      expect({ body: row.body, read: read(row.body) }).toEqual({
        body: row.body,
        read: row.asserts.map((a) => `${a.seq}:${a.claim}`),
      });
    }
  });
});
