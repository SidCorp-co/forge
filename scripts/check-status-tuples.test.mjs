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

  it('excuses a declaration whose marker NAMES the answer it mirrors', () => {
    const marked =
      '// status-tuple: differs — mirrors OWNER across a package boundary neither side may import.\n' +
      "export const MIRROR = ['closed', 'dropped'];\n";
    const { twoAnswers } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'owner.ts'),
      ...scan(marked, 'mirror.ts'),
    ]);
    expect(twoAnswers).toEqual([]);
  });

  it('does not excuse a marker further above than the marker reaches', () => {
    const tooFar =
      '// status-tuple: differs — stated too far above to be about OWNER.\n' +
      '\n'.repeat(8) +
      "export const MIRROR = ['closed', 'dropped'];\n";
    const { twoAnswers } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'owner.ts'),
      ...scan(tooFar, 'mirror.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
  });

  it('skips a SQL ARRAY literal, which is SQL wearing brackets', () => {
    expect(scan("await db.execute(sql`(ARRAY['closed','dropped'])[g]`);\n")).toEqual([]);
  });
});

describe('check-status-tuples — a marker is an excuse against the answer it names', () => {
  // ISS-1106 criterion 13: `runs-rollup.ts` declared a second `LIVE_JOB_STATUSES`
  // holding the UNHELD tuple, and the gate read green because the one constant
  // already holding that tuple carries a marker about a DIFFERENT one.
  const UNHELD =
    '/* status-tuple: differs — `held` waits on a person, so this cannot be LIVE. */\n' +
    "export const UNHELD = ['queued', 'dispatched', 'running'];\n";

  it('leaves a marked declaration standing alone as the one answer', () => {
    const { twoAnswers } = judge(scan(UNHELD, 'owner.ts'));
    expect(twoAnswers).toEqual([]);
  });

  it('refuses a SECOND declaration of that tuple, because the marker names neither it nor its value', () => {
    const { twoAnswers } = judge([
      ...scan(UNHELD, 'owner.ts'),
      ...scan("const SECOND = ['queued', 'dispatched', 'running'];\n", 'other.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
    expect(twoAnswers[0].declarations.map((d) => d.name)).toEqual(['UNHELD', 'SECOND']);
  });
});

describe('check-status-tuples — one name answers one question', () => {
  // A mirror shares a name AND a value, so it is one answer in two packages.
  // `runs-rollup.ts` shared the NAME and not the value, which by value alone
  // never collides with the four-member answer it was shadowing.
  it('refuses one name holding two different tuples', () => {
    const { twoMeanings } = judge([
      ...scan("export const LIVE = ['queued', 'dispatched', 'running', 'held'];\n", 'owner.ts'),
      ...scan("const LIVE = ['queued', 'dispatched', 'running'];\n", 'rollup.ts'),
    ]);
    expect(twoMeanings).toHaveLength(1);
    expect(twoMeanings[0].name).toBe('LIVE');
    expect(twoMeanings[0].declarations.map((d) => d.rel)).toEqual(['owner.ts', 'rollup.ts']);
  });

  it('lets one name hold one tuple in two packages, which is what a mirror is', () => {
    const { twoMeanings } = judge([
      ...scan("export const LIVE = ['queued', 'dispatched', 'running', 'held'];\n", 'core.ts'),
      ...scan("export const LIVE = ['queued', 'dispatched', 'running', 'held'];\n", 'web.ts'),
    ]);
    expect(twoMeanings).toEqual([]);
  });

  it('refuses it THROUGH a marker, because a marker naming the peer cannot disambiguate a shared name', () => {
    const marked =
      '/* status-tuple: differs — `held` waits on a person, so this cannot be LIVE. */\n' +
      "export const UNHELD = ['queued', 'dispatched', 'running'];\n";
    const { twoAnswers, twoMeanings } = judge([
      ...scan("export const LIVE = ['queued', 'dispatched', 'running', 'held'];\n", 'owner.ts'),
      ...scan(marked, 'owner2.ts'),
      ...scan("const LIVE = ['queued', 'dispatched', 'running'];\n", 'rollup.ts'),
    ]);
    expect(twoAnswers).toEqual([]);
    expect(twoMeanings.map((m) => m.name)).toEqual(['LIVE']);
  });
});

describe('check-status-tuples — a classification is a declaration by another route', () => {
  const RECORD =
    'const JOB_STATUS_IS_LIVE: Record<JobStatus, boolean> = {\n' +
    '  queued: true,\n  dispatched: true,\n  running: true,\n' +
    '  held: false,\n  done: false,\n  failed: false,\n};\n';

  it('reads the TRUE keys of a boolean classification as the tuple it answers with', () => {
    const sites = scan(RECORD, 'rollup.ts');
    expect(sites.map((s) => `${s.name} ${s.key}`)).toEqual([
      'JOB_STATUS_IS_LIVE job|dispatched,queued,running',
    ]);
  });

  it('refuses a classification holding a tuple a constant already holds', () => {
    const { twoAnswers } = judge([
      ...scan("export const UNHELD_LIVE = ['queued', 'dispatched', 'running'];\n", 'owner.ts'),
      ...scan(RECORD, 'rollup.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
    expect(twoAnswers[0].declarations.map((d) => d.name)).toEqual([
      'UNHELD_LIVE',
      'JOB_STATUS_IS_LIVE',
    ]);
  });

  it('leaves a lookup table alone: a Record to anything but boolean is not a yes/no question', () => {
    const labels =
      "const LABEL: Record<JobStatus, string> = {\n  queued: 'Queued',\n  running: 'Running',\n};\n";
    expect(scan(labels, 'derive.ts')).toEqual([]);
  });
});

describe('check-status-tuples — how much of a test file it reads', () => {
  const OWNER = "export const LIVE_JOB_STATUSES = ['queued', 'dispatched', 'running', 'held'];\n";
  const TEST = 'packages/core/tests/integration/reap-e2e.test.ts';

  it('reads a `.each` case list, which is the domain a test claims to cover', () => {
    const { restatements } = judge([
      ...scan(OWNER, 'owner.ts'),
      ...scan(
        "it.each(['queued', 'dispatched', 'running', 'held'])('leaves a `%s` job', () => {});\n",
        TEST,
      ),
    ]);
    expect(restatements).toHaveLength(1);
    expect(restatements[0].owner.name).toBe('LIVE_JOB_STATUSES');
  });

  it('leaves the assertion itself alone — importing the constant would assert nothing', () => {
    const { restatements } = judge([
      ...scan(OWNER, 'owner.ts'),
      ...scan("expect(jobStatuses).toEqual(['queued', 'dispatched', 'running', 'held']);\n", TEST),
    ]);
    expect(restatements).toEqual([]);
  });

  it('leaves a test-local constant alone, for the same reason', () => {
    const { twoAnswers } = judge([
      ...scan(OWNER, 'owner.ts'),
      ...scan("const EXPECTED = ['queued', 'dispatched', 'running', 'held'];\n", TEST),
    ]);
    expect(twoAnswers).toEqual([]);
  });
});

describe('check-status-tuples — how the source spells a status literal', () => {
  it('reads a double-quoted tuple, which is how the browser package is written', () => {
    const sites = scan('const OPEN = new Set(["closed", "dropped"]);\n', 'web.ts');
    expect(sites.map((s) => s.name)).toEqual(['OPEN']);
  });

  it('holds one answer to one question across the two spellings', () => {
    const { twoAnswers } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'core.ts'),
      ...scan('const OPEN = new Set(["dropped", "closed"]);\n', 'web.ts'),
    ]);
    expect(twoAnswers).toHaveLength(1);
    expect(twoAnswers[0].declarations.map((d) => d.name)).toEqual(['OWNER', 'OPEN']);
  });

  it('refuses a double-quoted inline copy of a tuple a constant already holds', () => {
    const { restatements } = judge([
      ...scan("export const OWNER = ['closed', 'dropped'];\n", 'core.ts'),
      ...scan('rows.filter((r) => ["closed", "dropped"].includes(r.status));\n', 'web.ts'),
    ]);
    expect(restatements).toHaveLength(1);
    expect(restatements[0].owner.name).toBe('OWNER');
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
