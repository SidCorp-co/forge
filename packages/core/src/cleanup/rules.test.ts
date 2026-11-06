/**
 * @direct-test-of packages/core/src/issues/cleanup-landing-port.ts
 */
import type { CleanupReportRequest } from '@forge/contracts/cleanup';
import { describe, expect, it } from 'vitest';
import { cleanupBrief, debtRefusals, reportOwed, reportRefusals, windowOffWords } from './rules.js';

const impact = (rating: 'low' | 'medium' | 'high') =>
  ({ type: 'data', rating, reason: `rated ${rating}` }) as const;
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const report = (over: Partial<CleanupReportRequest> = {}): CleanupReportRequest => ({
  base: { branch: 'dev', sha: 'c'.repeat(40) },
  result: 'green',
  cleared: [],
  remains: [],
  ...over,
});
const open = [
  { id: D1, where: 'packages/core/src/a.ts', rating: 'high' as const, carried: false },
  { id: D2, where: 'scripts/gate.mjs', rating: 'medium' as const, carried: true },
];

describe('debt an agent records (REQ-79 BC-3)', () => {
  it('takes a red rated low or medium, and refuses a red rated high: it holds its issue', () => {
    const red = (rating: 'low' | 'medium' | 'high') => ({
      kind: 'red' as const,
      check: 'verify',
      where: 'scripts',
      detail: 'copy budget over',
      impact: impact(rating),
    });
    expect(debtRefusals([red('low'), red('medium')])).toEqual([]);
    const refused = debtRefusals([red('medium'), red('high')]);
    expect(refused.map((r) => [r.code, r.path])).toEqual([
      ['DEBT_RED_HOLDS_THE_ISSUE', '/items/1/impact/rating'],
    ]);
  });

  it('takes debt and simplification rated high: only a red holds its issue', () => {
    expect(
      debtRefusals([{ kind: 'debt', where: 'x', detail: 'y', impact: impact('high') }]),
    ).toEqual([]);
  });
});

describe('what a cleanup report owes (REQ-79 BC-9)', () => {
  it('names every open debt once, cleared with how or remaining with why', () => {
    const whole = report({
      cleared: [{ debt: D1, how: 'fixed' }],
      remains: [{ debt: D2, why: 'needs a person' }],
    });
    expect(reportRefusals(whole, open)).toEqual([]);
    const short = reportRefusals(report({ cleared: [{ debt: D1, how: 'fixed' }] }), open);
    expect(short.map((r) => r.code)).toEqual(['CLEANUP_REPORT_INCOMPLETE']);
    expect(short[0]?.detail).toContain(D2);
    expect(short[0]?.detail).toContain('scripts/gate.mjs');
  });

  it('refuses a debt that is not open, and one named twice', () => {
    const twice = report({
      result: 'red',
      cleared: [{ debt: D1, how: 'fixed' }],
      remains: [
        { debt: D1, why: 'not fixed' },
        { debt: D2, why: 'later' },
      ],
    });
    expect(reportRefusals(twice, open).map((r) => r.code)).toEqual(['CLEANUP_DEBT_NAMED_TWICE']);
    const stranger = report({
      result: 'red',
      cleared: [{ debt: '33333333-3333-4333-8333-333333333333', how: 'x' }],
      remains: [
        { debt: D1, why: 'a' },
        { debt: D2, why: 'b' },
      ],
    });
    expect(reportRefusals(stranger, open).map((r) => r.code)).toEqual(['CLEANUP_DEBT_UNKNOWN']);
  });
});

const NOTHING_LANDED = { kind: 'none', branch: 'dev', head: 'c'.repeat(40) } as const;

describe("a cleanup run's brief (REQ-79 BC-7)", () => {
  // ISS-1050 (REQ-79 BC-20, BC-23): the run reviews what landed since the last report, by the audit
  // guide, and the brief points to it rather than carrying the method itself
  it('names the range that landed since the last report and the audit guide that reviews it', () => {
    const from = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const brief = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [],
      landed: { kind: 'landed', branch: 'dev', from, head },
    });
    expect(brief).toContain(`What landed on dev since the last cleanup report: ${from}..${head}`);
    expect(brief).toContain(`git log ${from}..${head}`);
    expect(brief).toContain('GET /api/guides/cleanup-audit.md');
    expect(brief).not.toContain('simplify the code you touch');
    // ISS-1057: the run is the Audit stage, apart from delivery, and what it finds goes back to Product
    expect(brief).toContain(
      'the Audit stage of Product → Delivery → Release → Audit, a job of its own',
    );
    expect(brief).toContain('return to Product what would change the product');
    const first = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [],
      landed: { kind: 'landed', branch: 'dev', from: null, head },
    });
    expect(first).toContain('no cleanup report yet');
    expect(first).toContain(head);
  });

  it('names the debt, its fire and the report it owes, and asks no report to cover a change', () => {
    const brief = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [
        {
          id: D1,
          kind: 'red',
          check: 'verify',
          where: 'scripts',
          rating: 'medium',
          issueKey: 'ISS-4',
          detail: 'copy budget over',
          carried: null,
          evidence: [],
        },
      ],
      landed: NOTHING_LANDED,
    });
    expect(brief).toContain(D1);
    // ISS-1057: the audit holds no change, so the brief lists none waiting and asks for no `covers`
    expect(brief).not.toContain('waiting on a green cleanup');
    expect(brief).not.toContain('covers');
    expect(brief).toContain('"f1"');
    expect(brief).toContain('/api/projects/p1/cleanup-reports');
    expect(brief).toContain("never take a delivery run's");
  });

  // ISS-814: fire b4557dc7 ended its turn "I'll be notified when it finishes" and never reported
  it('forbids ending the turn to wait on CI, and blocks on a reused run inside it', () => {
    const brief = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [],
      landed: NOTHING_LANDED,
    });
    expect(brief).toContain('This run is headless');
    expect(brief).toContain('never end your turn waiting on anything');
    expect(brief).toContain('your turn ends only after the report is posted');
    expect(brief).toContain('gh run list --branch <branch> --commit <sha>');
    expect(brief).toContain('gh run watch <run id> --exit-status');
    expect(brief).toContain(
      'red, with that run recorded as debt and left in remains, never nothing',
    );
  });
});

// ISS-842: debt 3d01ab3d, which no diff can clear, read green on four fires and red on cb6546d2
describe('a report green exactly when every debt it leaves is carried (REQ-79 BC-10)', () => {
  const codes = (r: ReturnType<typeof report>) => reportRefusals(r, open).map((x) => x.code);
  const both = [
    { debt: D1, why: 'a' },
    { debt: D2, why: 'b' },
  ];

  it('takes green over only carried debt, and red over a debt nobody carries', () => {
    expect(
      codes(report({ cleared: [{ debt: D1, how: 'x' }], remains: [{ debt: D2, why: 'b' }] })),
    ).toEqual([]);
    expect(codes(report({ result: 'red', remains: both }))).toEqual([]);
  });

  it('refuses green leaving a debt nobody carries, naming it', () => {
    const refused = reportRefusals(report({ remains: both }), open);
    expect(refused.map((r) => [r.code, r.path])).toEqual([['CLEANUP_RESULT_DISAGREES', '/result']]);
    expect(refused[0]?.detail).toContain(D1);
    expect(refused[0]?.detail).not.toContain(D2);
    expect(refused[0]?.detail).toContain('/debts/:debt/carry');
  });

  it('refuses red leaving only carried debt, or none', () => {
    const carriedOnly = report({
      result: 'red',
      cleared: [{ debt: D1, how: 'x' }],
      remains: [{ debt: D2, why: 'b' }],
    });
    expect(codes(carriedOnly)).toEqual(['CLEANUP_RESULT_DISAGREES']);
    const none = report({
      result: 'red',
      cleared: [
        { debt: D1, how: 'x' },
        { debt: D2, how: 'y' },
      ],
    });
    expect(codes(none)).toEqual(['CLEANUP_RESULT_DISAGREES']);
    expect(reportRefusals(none, open)[0]?.detail).toContain('leaves no debt');
  });

  it('prints each carried debt with its price, and says the result is not the run’s call', () => {
    const brief = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [
        {
          id: D2,
          kind: 'red',
          check: 'Deploy dev',
          where: '.github/workflows',
          rating: 'medium',
          issueKey: null,
          detail: 'the token is empty',
          carried: {
            trades: 'Deploy dev stays red',
            costs: 'hand deploys',
            endsWhen: 'the token is set',
            by: 'Decision Holder',
          },
          evidence: [
            { evidence: 'the hook answers 401', by: 'The Master', at: '2026-10-31T09:00:00.000Z' },
            { evidence: 'still 401 after the rotation', by: null, at: '2026-11-01T09:00:00.000Z' },
          ],
        },
      ],
      landed: NOTHING_LANDED,
    });
    expect(brief).toContain(
      'CARRIED, a priced amnesty by Decision Holder: trades Deploy dev stays red; costs hand deploys; ends when the token is set',
    );
    // ISS-839: the evidence given on it, oldest first, each in its giver's name
    expect(brief).toContain(
      '  evidence from The Master, 2026-10-31: the hook answers 401\n  evidence from someone no longer on Forge, 2026-11-01: still 401 after the rotation',
    );
    expect(brief).toContain('The result is not yours to judge (REQ-79 BC-10)');
    expect(brief).toContain('CLEANUP_RESULT_DISAGREES');
  });
});

describe('what the base owes the audit after a change rated high landed (REQ-79 BC-5)', () => {
  const T = new Date('2026-10-30T10:00:00.000Z');
  const green = {
    id: 'r1',
    result: 'green' as const,
    branch: 'dev',
    sha: 'c'.repeat(40),
    reportedAt: T,
  };

  it('owes a report after a red one, or where none follows the last high landing, and nothing else', () => {
    expect(reportOwed({ ...green, result: 'red' }, null)).toBe('red');
    expect(reportOwed(green, T)).toBe('stale');
    expect(reportOwed(null, T)).toBe('stale');
    expect(reportOwed(green, new Date(T.getTime() - 1000))).toBeNull();
    expect(reportOwed(null, null)).toBeNull();
  });

  it('says where no window is on, and who turns one on, never making one (ISS-1049)', () => {
    const window = {
      scheduleId: 'sched-1',
      cron: '0 18 * * *',
      timeZone: null,
      enabled: true,
      nextRunAt: '2026-10-30T18:00:00.000Z',
    };
    expect(windowOffWords('p-1', window)).toBeNull();
    const none = windowOffWords('p-1', null);
    expect(none).toContain('No cleanup window is on for this project');
    expect(none).toContain('a project admin turns one on');
    expect(none).toContain('projectId: "p-1"');
    const off = windowOffWords('p-1', { ...window, enabled: false });
    expect(off).toContain('is off, so no cleanup run starts here');
    expect(off).toContain('POST /api/schedules/sched-1/run');
    expect(off).not.toContain('/api/projects/:id/schedules');
  });
});
