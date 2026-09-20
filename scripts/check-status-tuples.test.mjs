import { describe, expect, it } from 'vitest';
import { attributeVocabulary, judge, sitesIn } from './check-status-tuples.mjs';

// FIXTURE TEXT — source this checker parses, not source this file runs.
const VOCABULARIES = {
  issue: new Set(['open', 'in_progress', 'testing', 'releasing', 'closed', 'dropped']),
  job: new Set(['queued', 'dispatched', 'running', 'held', 'done', 'failed']),
  session: new Set(['idle', 'queued', 'running', 'completed']),
};

const scan = (source, rel = 'packages/core/src/fixture.ts') => sitesIn(rel, source, VOCABULARIES);

describe('check-status-tuples — two declarations of one answer', () => {
  it('refuses two constants holding the same tuple, and names both', () => {
    const { twoAnswers } = judge([
      ...scan("export const A_STATUSES = ['closed', 'dropped'];\n", 'a.ts'),
      ...scan("export const B_STATUSES = ['dropped', 'closed'];\n", 'b.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
    expect(twoAnswers[0].declarations.map((d) => `${d.name} ${d.rel}:${d.line}`)).toEqual([
      'A_STATUSES a.ts:1',
      'B_STATUSES b.ts:1',
    ]);
  });

  it('compares by value and not by name — one name in two modules is still two answers', () => {
    const { twoAnswers } = judge([
      ...scan("const SAME = ['closed', 'dropped'];\n", 'a.ts'),
      ...scan("const SAME = ['closed', 'dropped'];\n", 'b.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
  });

  it('lets two tuples that differ by one member stand as two answers', () => {
    const { twoAnswers } = judge([
      ...scan("const LIVE = ['queued', 'dispatched', 'running', 'held'];\n", 'a.ts'),
      ...scan("const UNHELD = ['queued', 'dispatched', 'running'];\n", 'b.ts'),
    ]);
    expect(twoAnswers).toEqual([]);
  });
});

describe('check-status-tuples — an inline copy of a named answer', () => {
  const OWNER = "export const LIVE_JOB_STATUSES = ['queued', 'dispatched', 'running', 'held'];\n";

  it('refuses an inline array a constant already holds, and names the constant', () => {
    const { restatements } = judge([
      ...scan(OWNER, 'owner.ts'),
      ...scan(
        "await db.select().from(jobs).where(inArray(jobs.status, ['queued', 'dispatched', 'running', 'held']));\n",
        'caller.ts',
      ),
    ]);
    expect(restatements).toHaveLength(1);
    expect(restatements[0].owner.name).toBe('LIVE_JOB_STATUSES');
    expect(restatements[0].inline.rel).toBe('caller.ts');
  });

  it('leaves an inline array alone when no constant holds that tuple', () => {
    const { restatements } = judge(
      scan("const rows = await pick(['queued', 'dispatched', 'running', 'held']);\n", 'lone.ts'),
    );
    expect(restatements).toEqual([]);
  });
});

describe('check-status-tuples — what it deliberately does not read', () => {
  it('skips a tuple written as an object-literal value, which is a table row', () => {
    const sites = scan("const EXPECTED = {\n  release: ['closed', 'dropped'],\n};\n");
    expect(sites).toEqual([]);
  });

  it('skips a tuple no vocabulary holds', () => {
    expect(scan("const X = ['banana', 'plum'];\n")).toEqual([]);
  });

  it('excuses a declaration that says at the declaration why it must differ', () => {
    const marked =
      '// status-tuple: differs — mirrored across a package boundary neither side may import.\n' +
      "export const MIRROR = ['closed', 'dropped'];\n";
    const { twoAnswers } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'owner.ts'),
      ...scan(marked, 'mirror.ts'),
    ]);
    expect(twoAnswers).toEqual([]);
  });

  it('does not excuse a marker further above than the marker reaches', () => {
    const tooFar =
      '// status-tuple: differs — stated too far above to be about this declaration.\n' +
      '\n'.repeat(8) +
      "export const MIRROR = ['closed', 'dropped'];\n";
    const { twoAnswers } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'owner.ts'),
      ...scan(tooFar, 'mirror.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
  });
});

describe('check-status-tuples — which vocabulary a tuple is drawn from', () => {
  it('reads the vocabulary off the text when a tuple fits more than one', () => {
    const near = 'inArray(agentSessions.status, ';
    expect(attributeVocabulary(['queued', 'running'], near, VOCABULARIES)).toBe('session');
    expect(attributeVocabulary(['queued', 'running'], 'inArray(jobs.status, ', VOCABULARIES)).toBe(
      'job',
    );
  });

  it('measures nothing when a tuple fits two vocabularies and nothing says which', () => {
    expect(attributeVocabulary(['queued', 'running'], 'const X = ', VOCABULARIES)).toBeNull();
  });

  it('keeps two vocabularies apart, so one spelling is two answers', () => {
    const { twoAnswers } = judge([
      ...scan("const JOBS = ['queued', 'running', 'held'];\n", 'jobs.ts'),
      ...scan("const SESSIONS = ['idle', 'queued', 'running'];\n", 'sessions.ts'),
    ]);
    expect(twoAnswers).toEqual([]);
  });
});
