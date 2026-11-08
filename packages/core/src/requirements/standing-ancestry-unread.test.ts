// @direct-test-of packages/core/src/requirements/standing-proof.ts
// @direct-test-of packages/core/src/requirements/standing-shipped.ts
// @direct-test-of packages/core/src/requirements/standing-identity.ts
// ISS-1134: on forge-dev every push deploys a new sha, and until the served-ancestry pass reads the
// (judged, served) pair a verdict's hold on the live build is unanswered. REQ-78 read 0/7 and "file
// an issue for , or revise the requirement" at uptimes of 12 s and 72 s on 2026-11-08, its own
// verdicts all passing; REQ-47 asked to judge again what was judged. Unknown reads as unknown: a
// system wait naming the ancestry read, and no act is composed over an empty list of codes.
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveStanding, type StandingInput, type StandingIssue } from './standing.js';
import type { LiveBuildHolds } from './standing-identity.js';
import { codesAct } from './standing-proof.js';

const at = (iso: string) => new Date(iso);
const JUDGED = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);
const OLD = 'c'.repeat(40);
const ANCESTRY = `no release Forge verified, and no answer the source host gave Forge, shows whether the live build \`${LIVE}\` holds it`;

const closed = (n: number): StandingIssue => ({
  id: `i${n}`,
  displayId: `ISS-${n}`,
  title: `Issue ${n}`,
  status: 'closed',
  tone: 'neutral',
  updatedAt: at('2026-11-07T00:00:00Z'),
  closedAt: at('2026-11-07T00:00:00Z'),
  changedSincePlan: false,
  plannedRevision: 1,
  parkedOn: null,
});

const bc = (n: number) => ({
  id: `c${n}`,
  code: `BC-${n}`,
  body: `rule ${n}`,
  sinceRevision: 1,
  retiredRevision: null,
});

/** A pass recorded at the requirement itself on BC-<n>, judged at `commit`. */
const ownPass = (n: number, commit = JUDGED) => ({
  id: `v${n}`,
  requirementCriterionId: `c${n}`,
  verdict: 'pass' as const,
  verdictAt: at('2026-11-08T01:00:00Z'),
  note: null,
  evidence: [],
  commit,
  authored: true,
});

/** ISS-<issue>'s criterion tracing BC-<n>, passing at `commit`. */
const tracedPass = (issue: number, n: number, commit = JUDGED) => ({
  issueId: `i${issue}`,
  n,
  requirementCriterionId: `c${n}`,
  verdict: 'pass' as const,
  verdictAt: at('2026-11-08T01:00:00Z'),
  identity: { kind: 'commit', sha: commit } as const,
  byBuilder: false,
  authored: true,
  recordedAt: at('2026-11-08T01:00:00Z'),
});

/** The live build read at `LIVE`; `held` names what it is read to hold, `JUDGED` stays unanswered. */
const liveBuild = (held: Record<string, boolean> = {}): LiveBuildHolds => ({
  sha: LIVE,
  holds: new Map(Object.entries(held)),
  runtimes: new Map(),
  unanswered: new Map([[JUDGED, ANCESTRY]]),
});

function standing(over: Partial<StandingInput>) {
  const input = {
    status: 'in_delivery',
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
        createdAt: at('2026-11-01T00:00:00Z'),
        proposedAt: at('2026-11-01T00:00:00Z'),
        decidedAt: at('2026-11-01T00:00:00Z'),
      },
    ],
    currentRevision: 1,
    criteria: [bc(1), bc(2)],
    issues: [closed(1)],
    issueCriteria: [],
    requirementVerdicts: [ownPass(1), ownPass(2)],
    openSuggestionKinds: [],
    stalePins: [],
    staleContractPins: [],
    unapprovedDesigns: [],
    feedback: { open: 0, untriaged: [] },
    judge: 'independent',
    liveBuild: liveBuild(),
    agreedAt: at('2026-11-01T00:00:00Z'),
    release: null,
    updatedAt: at('2026-11-08T01:00:00Z'),
    statusSince: at('2026-11-07T00:00:00Z'),
    master: 'serves',
    now: at('2026-11-08T01:17:00Z'),
    ...over,
  } as StandingInput;
  const s = deriveStanding(input);
  expect(saidDisagreements(s)).toEqual([]);
  return s;
}

describe('a BC whose verdicts are unanswered on the live build waits on the ancestry read', () => {
  it('reads its own passing verdicts as unchecked, never "file an issue for ,"', () => {
    const s = standing({});
    expect(s.waitingOn.act).not.toContain('file an issue');
    expect(s.waitingOn.rule).not.toContain('hold no passing verdict yet');
    expect(s.waitingOn).toMatchObject({
      kind: 'release',
      who: 'Live build read',
      act: 'read whether the live build holds the verdicts on BC-1, BC-2',
    });
    expect(s.waitingOn.rule).toContain("BC-1, BC-2 wait on the live build's ancestry read");
    expect(s.attentionGroup).toBe('waiting');
  });

  it('asks nobody to judge again what an issue traced and judged at an unanswered commit', () => {
    const s = standing({
      criteria: [bc(11)],
      issueCriteria: [tracedPass(1, 11)],
      requirementVerdicts: [],
    });
    expect(s.waitingOn).toMatchObject({
      who: 'Live build read',
      act: 'read whether the live build holds the verdicts on BC-11',
    });
  });

  it('reads delivered once the pass answers that the live build holds the judged commit', () => {
    const s = standing({ liveBuild: { ...liveBuild({ [JUDGED]: true }), unanswered: new Map() } });
    expect(s.delivery.criteriaCoverage).toMatchObject({ criteria: 2, passing: 2 });
    expect(s.waitingOn.who).not.toBe('Live build read');
  });

  it('still asks the judge for a BC whose verdict the live build is read not to hold, the unread one named in the rule', () => {
    const s = standing({
      requirementVerdicts: [ownPass(1), ownPass(2, OLD)],
      liveBuild: liveBuild({ [OLD]: false }),
    });
    expect(s.waitingOn).toMatchObject({
      kind: 'agent',
      who: 'Independent judge',
      act: 'judge BC-2 on the running build',
    });
    expect(s.waitingOn.rule).toContain("BC-1 wait on the live build's ancestry read");
    expect(s.waitingOn.rule).toContain('BC-2 hold no passing verdict yet');
  });

  it('waits on the read for a shipped requirement too, never asking its judge to judge again', () => {
    const s = standing({ status: 'agreed', issues: [] });
    expect(s.waitingOn).toMatchObject({
      who: 'Live build read',
      act: 'read whether the live build holds the verdicts on BC-1, BC-2',
    });
  });
});

describe('no act is composed over an empty list of codes', () => {
  it('refuses by name to compose an act over no criterion', () => {
    for (const key of [
      'standing.act.fileOrRevise',
      'standing.act.trace',
      'standing.act.judgeShipped',
      'standing.act.readLiveBuild',
    ] as const) {
      expect(() => codesAct(key, [])).toThrow(`${key} composed over no code`);
    }
  });

  it('names every criterion it is composed over', () => {
    const row = (code: string) => ({
      code,
      body: '',
      verdict: 'gap' as const,
      issues: [],
      verdicts: [],
      counts: null,
      why: null,
      uncoveredReason: null,
    });
    expect(codesAct('standing.act.fileOrRevise', [row('BC-3'), row('BC-4')]).vars).toEqual({
      codes: 'BC-3, BC-4',
    });
  });
});
