import type {
  RequirementAttentionGroup,
  RequirementCoverage,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { verdictExercised } from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { askedOnRelease, holdsFor, type LiveBuildHolds } from './standing-identity.js';

export interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: WaitingOn<RequirementWaitingKind>;
}

const wait = (who: Said, act: Said, rule: Said): WaitingOn<RequirementWaitingKind> =>
  waitingOn('agent', { who, act, rule });

/** Who judges a criterion on the running build: by the policy's `qa`, or the building run itself where the gate profile counts its own pass (REQ-76 BC-7). */
export const JUDGE_WHO: Record<VerifiedJudge, Said> = {
  self: say('standing.who.master'),
  independent: say('standing.who.independentJudge'),
  builder: say('standing.who.master'),
};

const MASTER = say('standing.who.master');

const keysOf = (keys: readonly string[]) => [...new Set(keys)].join(', ');
/** The issues a verdict can still count on: those tracing the current wording that hold no
 *  judgement, or only one that does not count (on another build, or at an identity nothing checks). */
const openLinks = (c: RequirementCoverage) =>
  c.issues.filter((l) => !l.stale && (!verdictExercised(l.verdict) || l.notCounted !== null));
const unjudgedKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(rows.flatMap((c) => openLinks(c).map((l) => l.displayId)));
/** The issues whose trace sits on an earlier wording, where no verdict can count until it is tied again. */
const staleKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(rows.flatMap((c) => c.issues.filter((l) => l.stale).map((l) => l.displayId)));
/** The issue whose fail is the newest verdict, the one that counts, or the requirement where its own
 *  verdict is (ISS-588). */
const failingKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(
    rows.flatMap((c) =>
      c.counts ? [c.counts.source === 'issue' ? c.counts.displayId : 'the requirement'] : [],
    ),
  );

const codesOf = (rows: readonly RequirementCoverage[]) => rows.map((c) => c.code).join(', ');

/**
 * Whether every judgement on the current wording of `c` was weighed and counts on no build where it
 * was judged, its criterion saying why (ISS-1018): judging it again at the same identity changes
 * nothing, so the turn names that reason, and the identity that would count, rather than asking for
 * the judgement once more. A link no judgement was recorded on still owes one, and so does one whose
 * build counts and whose judge does not (`inLiveBuild` true: the policy's judge has not judged it).
 */
const judgedUncounted = (c: RequirementCoverage) => {
  const current = [...c.issues, ...c.verdicts].filter((l) => !l.stale);
  return (
    c.why !== null &&
    current.length > 0 &&
    current.every(
      (l) => verdictExercised(l.verdict) && l.notCounted !== null && l.inLiveBuild !== true,
    )
  );
};

/**
 * Where a project's production names no commit it serves (ISS-900), a verdict on a release its agent
 * recorded counts: the release a judgement counts on, or `none` where no release is recorded, so no
 * judgement can count yet; on a promotion project, whose landings a commit counts at, only once one
 * is recorded (`standing-identity.ts:askedOnRelease`). Null on any other project.
 */
export type ReleaseAsk = { version: string } | 'none' | null;

/** Per issue, what its own project asks a verdict on (`releaseAskOf` of the build
 *  `standing-identity.ts:holdsFor` weighs it on): another project's issue is judged on its release. */
export type IssueReleaseAsk = (issueId: string) => ReleaseAsk;

/** Each open link of `rows` (`unjudgedKeys`) with what its issue's project asks a verdict on. */
const askedOf = (rows: readonly RequirementCoverage[], askOf: IssueReleaseAsk) =>
  rows.flatMap((c) =>
    openLinks(c).map((l) => ({ code: c.code, key: l.displayId, ask: askOf(l.issueId) })),
  );
type Asked = ReturnType<typeof askedOf>[number];
const codesIn = (links: readonly Asked[]) => keysOf(links.map((l) => l.code));
const keysIn = (links: readonly Asked[]) => keysOf(links.map((l) => l.key));

/** The release each link is asked on: the one version, or each with the issues judged on it. */
function versionsIn(links: readonly Asked[]): string {
  const of = (l: Asked) => (l.ask && l.ask !== 'none' ? l.ask.version : '');
  const versions = [...new Set(links.map(of))];
  if (versions.length === 1) return versions[0] ?? '';
  return versions.map((v) => `${v} (${keysIn(links.filter((l) => of(l) === v))})`).join(', ');
}

export function releaseAskOf(live: LiveBuildHolds | null | undefined): ReleaseAsk {
  const line = askedOnRelease(live);
  if (!line) return null;
  return line.live ? { version: line.live.version } : 'none';
}

/** Each issue's own ask: another project's issue on the build its project is read on (`holdsFor`). */
export const issueReleaseAskOf =
  (live: LiveBuildHolds | null | undefined): IssueReleaseAsk =>
  (issueId) =>
    releaseAskOf(holdsFor(live ?? null, issueId));

/** The requirement project's ask and each issue's own, as `proofTurn` takes them. */
export const releaseAsksOf = (live: LiveBuildHolds | null | undefined) =>
  [releaseAskOf(live), issueReleaseAskOf(live)] as const;

/**
 * The turn of a requirement whose unjudged criteria (`codes`) can count only on a release (ISS-900):
 * the judge judges them at the requirement on the release the record says is live, once, never on
 * issues whose commits nothing places; with none recorded no judgement can count, so the master owes
 * the record and nobody is asked to judge.
 */
export function releaseTurn(
  judge: VerifiedJudge | null,
  release: Exclude<ReleaseAsk, null>,
  codes: string,
  rule: Said,
): Turn {
  if (release === 'none') {
    return { group: 'waiting', waitingOn: wait(MASTER, say('standing.act.recordRelease'), rule) };
  }
  return {
    group: 'waiting',
    waitingOn: wait(
      JUDGE_WHO[judge ?? 'self'],
      say('standing.act.judgeOnRelease', { codes, version: release.version }),
      rule,
    ),
  };
}

/** What a requirement's revisions say about its BCs: when each was live, and when each revision was accepted. */
export interface RequirementRevisions {
  readonly criteria: readonly {
    code: string;
    sinceRevision: number;
    retiredRevision: number | null;
  }[];
  readonly revisions: readonly { revision: number; state: string; decidedAt: Date | null }[];
  readonly currentRevision: number | null;
}

/** The revision that was the requirement's head at `at`: the newest accepted by then; null for none. */
function headAt(
  revisions: readonly { revision: number; state: string; decidedAt: Date | null }[],
  at: Date,
): number | null {
  const accepted = revisions.filter(
    (r) =>
      (r.state === 'current' || r.state === 'superseded') &&
      r.decidedAt !== null &&
      r.decidedAt <= at,
  );
  return accepted.length > 0 ? Math.max(...accepted.map((r) => r.revision)) : null;
}

/**
 * Whether a linked issue can still carry BC `code` (FB-209): one built against a revision at which
 * that code was live, so the BC was among what it was built for and only its trace is missing. That
 * revision is the one its plan was written against; for an issue recording none, the head when it
 * closed, and while it is open (or nothing was accepted by then), the current one. Where a later
 * revision added the BC after every linked issue was built, none was built for it, and tying one to
 * it would claim work nobody did there: a criterion proves a BC of its own issue's requirement
 * (`issues/criteria/own-requirement.ts`), so the BC is owed an issue of its own or a revision.
 */
export function carriedByLinked(
  live: readonly { plannedRevision?: number | null; closedAt: Date | null }[],
  { criteria, revisions, currentRevision: current }: RequirementRevisions,
): (code: string) => boolean {
  const builtAt = live.map(
    (issue) =>
      issue.plannedRevision ??
      (issue.closedAt ? headAt(revisions, issue.closedAt) : null) ??
      current,
  );
  return (code) =>
    builtAt.some(
      (built) =>
        built === null ||
        criteria.some(
          (c) =>
            c.code === code &&
            c.sinceRevision <= built &&
            (c.retiredRevision === null || c.retiredRevision > built),
        ),
    );
}

// Every live issue has shipped and a BC is still unproven: the turn is whoever owes that proof, by
// what each unproven BC lacks. A traced criterion with no verdict waits on the project's judge to
// judge it on the issues tracing its current wording; one traced only on an earlier wording, on the
// judge to tie those issues to the current wording first (no verdict on the old one can count); a
// failing one on the master to fix it, naming the issue whose fail is the newest; one no criterion
// traces to on the master to trace it where a linked issue can carry it (`carriedByLinked`), and
// where none can, on the master to file an issue for it or revise the requirement, since no trace
// can be made. One every judgement of which was recorded and counts on no build names why, and what
// would count (`judgedUncounted`, ISS-1018), never asking for the same judgement again.
// The judge's acts go first, since they need no new work, then a trace; the
// rule names every unproven BC. Where a verdict counts only on a release (`releaseAskOf`, ISS-900),
// the judge judges on that release: on the issues tracing the current wording, which carry a release
// verdict as the requirement does, and at the requirement only for what no such issue traces
// (`releaseTurn`); with no release recorded, the master owes the record.
export function proofTurn(
  judge: VerifiedJudge | null,
  live: readonly { status: string; plannedRevision?: number | null; closedAt: Date | null }[],
  coverage: readonly RequirementCoverage[],
  release: ReleaseAsk = null,
  /** Per issue, its own project's ask (ISS-900); absent, every issue is the requirement project's. */
  issueRelease: IssueReleaseAsk = () => release,
  /** Its revisions, which say whether a linked issue can carry an untraced BC (`carriedByLinked`);
   *  absent, every one can. */
  requirement: RequirementRevisions | null = null,
): Turn | null {
  const unproven = coverage.filter((c) => c.verdict !== 'passing');
  if (live.length === 0 || !live.every((i) => i.status === 'closed') || unproven.length === 0) {
    return null;
  }
  const unjudged = unproven.filter(
    (c) => c.verdict === 'not_judged' || c.verdict === 'stale' || c.verdict === 'not_live',
  );
  const judgeable = unjudged.filter((c) => unjudgedKeys([c]) !== '');
  const retie = unjudged.filter((c) => unjudgedKeys([c]) === '' && staleKeys([c]) !== '');
  const failing = unproven.filter((c) => c.verdict === 'failing');
  const gaps = unproven.filter((c) => c.verdict === 'gap');
  const parts = [
    unjudged.length > 0 ? say('requirements.rule.unjudged', { codes: codesOf(unjudged) }) : null,
    unjudged.length > 0 && release === 'none' ? say('requirements.rule.noReleaseRecorded') : null,
    failing.length > 0 ? say('requirements.rule.failed', { codes: codesOf(failing) }) : null,
    gaps.length > 0 ? say('requirements.rule.untraced', { codes: codesOf(gaps) }) : null,
  ].filter((p): p is Said => p !== null);
  const rule = say('requirements.rule.notDelivered', {
    parts,
    undeclared: judge === null ? say('requirements.rule.noJudge') : null,
  });
  // each issue is asked what its own project counts: a release, a record, or a commit (ISS-900)
  const asked = askedOf(judgeable, issueRelease);
  const onRelease = asked.filter((l) => l.ask !== null && l.ask !== 'none');
  const uncountedCodes = new Set(judgeable.filter(judgedUncounted).map((c) => c.code));
  const byCommit = asked.filter((l) => l.ask === null && !uncountedCodes.has(l.code));
  const uncounted = judgeable.filter(
    (c) => uncountedCodes.has(c.code) && asked.some((l) => l.code === c.code && l.ask === null),
  );
  if (onRelease.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.judgeOnReleaseOn', {
          codes: codesIn(onRelease),
          keys: keysIn(onRelease),
          version: versionsIn(onRelease),
        }),
        rule,
      ),
    };
  }
  if (byCommit.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.judgeOn', { codes: codesIn(byCommit), keys: keysIn(byCommit) }),
        rule,
      ),
    };
  }
  if (uncounted.length > 0) {
    // every judgement was recorded and counts on no build: the judge is told why and what would count
    const why =
      uncounted.length === 1
        ? (uncounted[0]?.why ?? '')
        : uncounted.map((c) => `${c.code}: ${c.why}`).join('; ');
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.uncounted', { codes: codesOf(uncounted), why }),
        rule,
      ),
    };
  }
  if (asked.length > 0) return releaseTurn(judge, 'none', codesIn(asked), rule);
  if (release && unjudged.length > 0) return releaseTurn(judge, release, codesOf(unjudged), rule);
  if (retie.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.retie', { codes: codesOf(retie), keys: staleKeys(retie) }),
        rule,
      ),
    };
  }
  if (failing.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        MASTER,
        say('standing.act.fixFailing', { codes: codesOf(failing), keys: failingKeys(failing) }),
        rule,
      ),
    };
  }
  const carries = requirement ? carriedByLinked(live, requirement) : () => true;
  const traceable = gaps.filter((c) => carries(c.code));
  return {
    group: 'waiting',
    waitingOn: wait(
      MASTER,
      traceable.length > 0
        ? say('standing.act.trace', { codes: codesOf(traceable) })
        : say('standing.act.fileOrRevise', { codes: codesOf(gaps) }),
      rule,
    ),
  };
}
