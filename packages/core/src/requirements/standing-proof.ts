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

const JUDGED = new Set(['pass', 'short', 'fail']);
const keysOf = (keys: readonly string[]) => [...new Set(keys)].join(', ');
/** The issues a verdict can still count on: those tracing the current wording that hold no judgement. */
const unjudgedKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(
    rows.flatMap((c) =>
      c.issues.filter((l) => !l.stale && !JUDGED.has(l.verdict ?? '')).map((l) => l.displayId),
    ),
  );
/** The issues whose trace sits on an earlier wording, where no verdict can count until it is tied again. */
const staleKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(rows.flatMap((c) => c.issues.filter((l) => l.stale).map((l) => l.displayId)));
/** The issue whose fail is the newest verdict, the one that counts. */
const failingKeys = (rows: readonly RequirementCoverage[]) =>
  keysOf(rows.flatMap((c) => (c.counts ? [c.counts.displayId] : [])));

const codesOf = (rows: readonly RequirementCoverage[]) => rows.map((c) => c.code).join(', ');

// Every live issue has shipped and a BC is still unproven: the turn is whoever owes that proof, by
// what each unproven BC lacks. A traced criterion with no verdict waits on the project's judge to
// judge it on the issues tracing its current wording; one traced only on an earlier wording, on the
// judge to tie those issues to the current wording first (no verdict on the old one can count); a
// failing one on the master to fix it, naming the issue whose fail is the newest; one no criterion
// traces to on the master to trace it. The judge's acts go first, since they need no new work; the
// rule names every unproven BC.
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
  const judgeable = unjudged.filter((c) => unjudgedKeys([c]) !== '');
  const retie = unjudged.filter((c) => unjudgedKeys([c]) === '' && staleKeys([c]) !== '');
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
