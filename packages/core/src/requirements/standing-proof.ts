import type {
  RequirementAttentionGroup,
  RequirementCoverage,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { verdictExercised } from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import type { LiveBuildHolds } from './standing-identity.js';

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
const unjudgedKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(
    rows.flatMap((c) =>
      c.issues
        .filter((l) => !l.stale && (!verdictExercised(l.verdict) || l.notCounted !== null))
        .map((l) => l.displayId),
    ),
  );
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
 * Where a project's production names no commit it serves and its issues are weighed on that live
 * build rather than at their landings (ISS-900), a verdict counts only on a release its agent recorded:
 * the release a judgement at the requirement counts on, or `none` where no release is recorded, so no
 * judgement can count yet. Null on any other project, where the judge judges on the issues.
 */
export type ReleaseAsk = { version: string } | 'none' | null;

export function releaseAskOf(live: LiveBuildHolds | null | undefined): ReleaseAsk {
  const line = live?.released;
  if (!line || live?.landed) return null;
  return line.live ? { version: line.live.version } : 'none';
}

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

// Every live issue has shipped and a BC is still unproven: the turn is whoever owes that proof, by
// what each unproven BC lacks. A traced criterion with no verdict waits on the project's judge to
// judge it on the issues tracing its current wording; one traced only on an earlier wording, on the
// judge to tie those issues to the current wording first (no verdict on the old one can count); a
// failing one on the master to fix it, naming the issue whose fail is the newest; one no criterion
// traces to on the master to trace it. The judge's acts go first, since they need no new work; the
// rule names every unproven BC. Where a verdict counts only on a release (`releaseAskOf`, ISS-900),
// the judge judges at the requirement on that release instead (`releaseTurn`).
export function proofTurn(
  judge: VerifiedJudge | null,
  live: readonly { status: string }[],
  coverage: readonly RequirementCoverage[],
  release: ReleaseAsk = null,
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
  if (release && unjudged.length > 0) return releaseTurn(judge, release, codesOf(unjudged), rule);
  if (judgeable.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.judgeOn', { codes: codesOf(judgeable), keys: unjudgedKeys(judgeable) }),
        rule,
      ),
    };
  }
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
  return {
    group: 'waiting',
    waitingOn: wait(MASTER, say('standing.act.trace', { codes: codesOf(gaps) }), rule),
  };
}
