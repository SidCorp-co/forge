import type { PolicyQaMode } from '@forge/contracts/project-config';
import type {
  RequirementAttentionGroup,
  RequirementCoverage,
  RequirementWaitingKind,
} from '@forge/contracts/requirements';
import type { WaitingOn } from '@forge/contracts/standing';

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: WaitingOn<RequirementWaitingKind>;
}

const wait = (who: string, act: string, rule: string): WaitingOn<RequirementWaitingKind> => ({
  kind: 'agent',
  who,
  act,
  rule,
  ref: null,
  dueAt: null,
});

const JUDGE_WHO: Record<PolicyQaMode, string> = {
  self: 'Master',
  independent: 'Independent judge',
};

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
    unjudged.length > 0 ? `${codesOf(unjudged)} hold no passing verdict yet` : null,
    failing.length > 0 ? `${codesOf(failing)} failed` : null,
    gaps.length > 0 ? `no issue criterion traces to ${codesOf(gaps)}` : null,
  ].filter((p): p is string => p !== null);
  const undeclared = judge === null ? '; no policy names a judge, so the master judges' : '';
  const rule = `every linked issue has shipped, but ${parts.join('; ')}, so it is not delivered${undeclared}`;
  if (unjudged.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        JUDGE_WHO[judge ?? 'self'],
        `judge ${codesOf(unjudged)} on ${keysOf(unjudged)}`,
        rule,
      ),
    };
  }
  if (failing.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait('Master', `fix ${codesOf(failing)}, failing on ${keysOf(failing)}`, rule),
    };
  }
  return {
    group: 'waiting',
    waitingOn: wait('Master', `trace ${codesOf(gaps)} to an issue criterion`, rule),
  };
}
