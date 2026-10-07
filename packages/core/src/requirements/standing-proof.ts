import type { PolicyQaMode } from '@forge/contracts/project-config';
import type {
  RequirementAttentionGroup,
  RequirementCoverage,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: WaitingOn<RequirementWaitingKind>;
}

const wait = (who: Said, act: Said, rule: Said): WaitingOn<RequirementWaitingKind> =>
  waitingOn('agent', { who, act, rule });

const JUDGE_WHO: Record<PolicyQaMode, Said> = {
  self: say('standing.who.master'),
  independent: say('standing.who.independentJudge'),
};

const MASTER = say('standing.who.master');

const keysOf = (rows: readonly RequirementCoverage[]) =>
  [
    ...new Set(
      rows.flatMap((c) =>
        c.issues
          .filter((l) => l.verdict !== 'pass' && l.verdict !== 'short')
          .map((l) => l.displayId),
      ),
    ),
  ].join(', ');

const codesOf = (rows: readonly RequirementCoverage[]) => rows.map((c) => c.code).join(', ');

// Every live issue has shipped and a BC is still unproven: the turn is whoever owes that proof, by
// what each unproven BC lacks. A traced criterion with no verdict (or one only on an earlier
// wording) waits on the project's judge to judge it on the issues that carry it; a failing one on
// the master to fix it; one no criterion traces to on the master to trace it. The judge's act goes
// first, since it is the one that needs no new work; the rule names every unproven BC.
export function proofTurn(
  judge: PolicyQaMode | null,
  live: readonly { status: string }[],
  coverage: readonly RequirementCoverage[],
): Turn | null {
  const unproven = coverage.filter((c) => c.verdict !== 'passing');
  if (live.length === 0 || !live.every((i) => i.status === 'closed') || unproven.length === 0) {
    return null;
  }
  const unjudged = unproven.filter((c) => c.verdict === 'not_judged' || c.verdict === 'stale');
  const failing = unproven.filter((c) => c.verdict === 'failing');
  const gaps = unproven.filter((c) => c.verdict === 'gap');
  const parts = [
    unjudged.length > 0 ? say('requirements.rule.unjudged', { codes: codesOf(unjudged) }) : null,
    failing.length > 0 ? say('requirements.rule.failed', { codes: codesOf(failing) }) : null,
    gaps.length > 0 ? say('requirements.rule.untraced', { codes: codesOf(gaps) }) : null,
  ].filter((p): p is Said => p !== null);
  const rule = say('requirements.rule.notDelivered', {
    parts,
    undeclared: judge === null ? say('requirements.rule.noJudge') : null,
  });
  if (unjudged.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        say('standing.act.judgeOn', { codes: codesOf(unjudged), keys: keysOf(unjudged) }),
        rule,
      ),
    };
  }
  if (failing.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        MASTER,
        say('standing.act.fixFailing', { codes: codesOf(failing), keys: keysOf(failing) }),
        rule,
      ),
    };
  }
  return {
    group: 'waiting',
    waitingOn: wait(MASTER, say('standing.act.trace', { codes: codesOf(gaps) }), rule),
  };
}
