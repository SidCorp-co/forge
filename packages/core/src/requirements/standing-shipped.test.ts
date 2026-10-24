// The standing of an agreed requirement whose capability already shipped (ISS-588,
// `standing-shipped.ts`): read from verdicts recorded on its criteria at the requirement itself,
// never assumed, through the standing that carries it.
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingRequirementVerdict } from './standing.js';

const at = (iso: string) => new Date(iso);
const LIVE = 'c'.repeat(40);
const HELD = 'a'.repeat(40);
const GONE = 'b'.repeat(40);

const bc = (n: number, since = 1, retired: number | null = null) => ({
  id: `c${n}-${since}`,
  code: `BC-${n}`,
  body: `rule ${n}`,
  sinceRevision: since,
  retiredRevision: retired,
});

const verdict = (
  criterion: string,
  word: StandingRequirementVerdict['verdict'],
  iso: string,
  commit: string | null = HELD,
): StandingRequirementVerdict => ({
  id: `${criterion}-${iso}`,
  requirementCriterionId: criterion,
  verdict: word,
  verdictAt: at(iso),
  note: `${word} on the running build`,
  evidence: ['https://example.test/clip.webm'],
  commit: word === 'skipped' ? null : commit,
  authored: true,
});

const read = (
  verdicts: StandingRequirementVerdict[],
  more: { criteria?: ReturnType<typeof bc>[]; judge?: 'self' | 'independent' | null } = {},
) => {
  const s = deriveStanding({
    status: 'agreed',
    owner: { id: 'u1', name: 'Ba', kind: 'human' },
    viewer: null,
    revisions: [
      {
        revision: 1,
        state: 'current',
        authorId: 'u1',
        authorName: 'Ba',
        authorKind: 'human',
        authorAgency: 'human',
        createdAt: at('2026-10-01T00:00:00Z'),
        proposedAt: at('2026-10-01T01:00:00Z'),
        decidedAt: at('2026-10-01T02:00:00Z'),
      },
    ],
    currentRevision: 1,
    criteria: more.criteria ?? [bc(1), bc(2)],
    issues: [],
    issueCriteria: [],
    requirementVerdicts: verdicts,
    openSuggestionKinds: [],
    stalePins: [],
    staleContractPins: [],
    unapprovedDesigns: [],
    feedback: { open: 0, untriaged: [] },
    judge: more.judge === undefined ? 'independent' : more.judge,
    agreedAt: at('2026-10-01T02:00:00Z'),
    release: null,
    liveBuild: {
      sha: LIVE,
      holds: new Map([
        [HELD, true],
        [GONE, false],
      ]),
      runtimes: new Map(),
      unanswered: new Map(),
    },
    updatedAt: at('2026-10-01T02:00:00Z'),
    statusSince: at('2026-10-01T02:00:00Z'),
    master: 'serves',
    now: at('2026-10-02T00:00:00Z'),
  });
  expect(saidDisagreements(s)).toEqual([]);
  return s;
};

const kinds = (s: ReturnType<typeof read>) => s.tasks.map((t) => t.kind);

describe('an agreed requirement with no issue', () => {
  it('owes its breakdown to the master while no verdict was recorded at it', () => {
    const s = read([]);
    expect(kinds(s)).toEqual(['breakdown']);
    expect(s.waitingOn.says.act.key).toBe('standing.act.breakDownBy');
    expect(s.next).toBe('in_delivery');
  });

  it('every criterion passing at the requirement: no breakdown, its accept is next', () => {
    const s = read([
      verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'pass', '2026-10-01T11:00:00Z'),
    ]);
    expect(kinds(s)).toEqual([]);
    expect(s.waitingOn.says.act.key).toBe('standing.act.acceptShipped');
    expect(s.waitingOn.says.rule.key).toBe('requirements.rule.shippedProven');
    expect(s.next).toBe('accepted');
    expect(s.coverage.map((c) => [c.code, c.verdict, c.counts?.source])).toEqual([
      ['BC-1', 'passing', 'requirement'],
      ['BC-2', 'passing', 'requirement'],
    ]);
  });

  it('a criterion with no counted pass waits on the judge, naming it, and owes no breakdown', () => {
    const s = read([verdict('c1-1', 'pass', '2026-10-01T10:00:00Z')]);
    expect(kinds(s)).toEqual([]);
    expect(s.waitingOn.says.who.key).toBe('standing.who.independentJudge');
    expect(s.waitingOn.says.act).toEqual({
      key: 'standing.act.judgeShipped',
      vars: { codes: 'BC-2' },
    });
    expect(s.waitingOn.rule).toContain('BC-2');
  });

  it('with no policy, the master judges and the rule says why', () => {
    const s = read([verdict('c1-1', 'pass', '2026-10-01T10:00:00Z')], { judge: null });
    expect(s.waitingOn.says.who.key).toBe('standing.who.master');
    expect(s.waitingOn.rule).toContain('no policy names a judge');
  });

  it('a failing criterion waits on the master to break it down, with the breakdown task due', () => {
    const s = read([
      verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'fail', '2026-10-01T11:00:00Z'),
    ]);
    expect(kinds(s)).toEqual(['breakdown']);
    expect(s.waitingOn.says.who.key).toBe('standing.who.master');
    expect(s.waitingOn.says.act).toEqual({
      key: 'standing.act.breakDownFailing',
      vars: { codes: 'BC-2' },
    });
    expect(s.waitingOn.dueAt).toBe(s.tasks[0]?.dueAt);
  });

  it('an unjudged criterion goes before a failing one: the judge acts first, the task stays', () => {
    const s = read([verdict('c1-1', 'fail', '2026-10-01T10:00:00Z')], { criteria: [bc(1), bc(2)] });
    expect(kinds(s)).toEqual(['breakdown']);
    expect(s.waitingOn.says.act).toEqual({
      key: 'standing.act.judgeShipped',
      vars: { codes: 'BC-2' },
    });
    expect(s.waitingOn.rule).toContain('BC-1 failed');
  });
});

describe('a verdict recorded at the requirement', () => {
  it('counts only on a build the live one holds, naming why it does not', () => {
    const s = read([
      verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'pass', '2026-10-01T11:00:00Z', GONE),
    ]);
    const two = s.coverage.find((c) => c.code === 'BC-2');
    expect(two?.verdict).toBe('not_live');
    expect(two?.verdicts[0]?.notCounted).toContain('does not hold');
    expect(two?.why).toContain("the requirement's own verdict");
  });

  it('stands on its newest: an older pass is kept on the line, replaced by a newer fail', () => {
    const s = read([
      verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'fail', '2026-10-01T12:00:00Z'),
    ]);
    const two = s.coverage.find((c) => c.code === 'BC-2');
    expect(two?.verdict).toBe('failing');
    expect(two?.verdicts.map((v) => [v.verdict, v.notCounted === null])).toEqual([
      ['fail', true],
      ['pass', false],
    ]);
  });

  it('a short never counts', () => {
    const s = read([
      verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
      verdict('c2-1', 'short', '2026-10-01T10:00:00Z'),
    ]);
    expect(s.coverage.find((c) => c.code === 'BC-2')?.verdict).toBe('not_judged');
  });

  it('on an earlier wording reads stale and owes the judge, not a breakdown', () => {
    const s = read(
      [
        verdict('c1-1', 'pass', '2026-10-01T10:00:00Z'),
        verdict('c2-1', 'pass', '2026-10-01T10:00:00Z'),
      ],
      {
        criteria: [bc(1), bc(2, 1, 1), bc(2, 1)].map((c, i) =>
          i === 2 ? { ...c, id: 'c2-new' } : c,
        ),
      },
    );
    const two = s.coverage.find((c) => c.code === 'BC-2');
    expect(two?.verdict).toBe('stale');
    expect(two?.verdicts[0]?.stale).toBe(true);
    expect(kinds(s)).toEqual([]);
    expect(s.waitingOn.says.act.vars).toEqual({ codes: 'BC-2' });
  });
});
