import type { ReleaseGateOwner, ReleaseGateView } from '@forge/contracts/releases';
import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { type Said, type SaidPlainKey, say, sayEn } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct } from '@forge/contracts/standing';
import { agrees } from '../lib/plural.js';
import type { ReleaseBlocker, ReleaseReasonCode, ReleaseWarning } from './blocker-sentences.js';

type Details = Record<string, unknown> | undefined;

interface Reading {
  title: SaidPlainKey;
  plain: (details: Details) => Said;
}

type Owing = 'master' | 'admin' | 'system';

interface Owed {
  by: Owing;
  act: (details: Details) => Said;
  /** What doing the act changes, where its words leave that open. */
  effect?: (details: Details) => Said;
}

const numberOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

interface Held {
  displayId: string;
  criteria: number[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const heldOf = (d: Details): Held[] => (Array.isArray(d?.held) ? (d?.held as Held[]) : []);

function issuesNamed(d: Details): string[] {
  const shown = strings(d?.displayIds);
  if (shown.length > 0) return shown;
  return heldOf(d).map((h) => h.displayId);
}

const NAMED_AT_MOST = 5;

interface Subject {
  said: Said;
  n: number;
}

// The issues a gate's sentence names: a count ("3 issues"), keys ("ISS-1, ISS-2"), or keys and the rest ("… and 2 more").
function subjectOf(d: Details): Subject {
  const names = issuesNamed(d);
  if (names.length === 0) {
    const n = Array.isArray(d?.issueIds) ? d.issueIds.length : 0;
    return {
      said: say('standing.gate.subject.count', { n, issues: agrees(n, 'issue', 'issues') }),
      n,
    };
  }
  const keys = names.slice(0, NAMED_AT_MOST).join(', ');
  const rest = names.length - NAMED_AT_MOST;
  return {
    said:
      rest > 0
        ? say('standing.gate.subject.more', { keys, n: rest })
        : say('standing.gate.subject.keys', { keys }),
    n: names.length,
  };
}

const theirs = (d: Details, one: string, many: string): string => agrees(subjectOf(d).n, one, many);

/** What each held issue still owes, one sentence each; `none` where nothing names one. */
const owes = (d: Details, none: Said): Said[] => {
  const held = heldOf(d);
  if (held.length === 0) return [none];
  return held.map((h) =>
    say('standing.gate.owes', {
      key: h.displayId,
      word: agrees(h.criteria.length, 'criterion', 'criteria'),
      list: h.criteria.join(', '),
    }),
  );
};

const withSubject = (
  key: 'standing.gate.claimed' | 'standing.gate.noteMissing' | 'standing.gate.unmerged',
  d: Details,
  verb: [string, string],
): Said => {
  const s = subjectOf(d);
  const agree = agrees(s.n, ...verb);
  return key === 'standing.gate.claimed'
    ? say(key, { subject: s.said, verb: agree, obj: theirs(d, 'it', 'them') })
    : key === 'standing.gate.unmerged'
      ? say(key, { subject: s.said, verb: agree, their: theirs(d, 'its', 'their') })
      : say(key, { subject: s.said, verb: agree });
};

const plain =
  (key: SaidPlainKey): Reading['plain'] =>
  () =>
    say(key);

const READINGS: Record<ReleaseReasonCode, Reading> = {
  NO_RELEASE_GATE: { title: 'standing.gate.title.noGate', plain: plain('standing.gate.noGate') },
  RELEASE_TARGET_UNDECLARED: {
    title: 'standing.gate.title.nowhere',
    plain: plain('standing.gate.nowhere'),
  },
  CLAIM_CONFLICT: {
    title: 'standing.gate.title.claimed',
    plain: (d) => withSubject('standing.gate.claimed', d, ['is', 'are']),
  },
  RELEASE_ROSTER_EMPTY: {
    title: 'standing.gate.title.empty',
    plain: (d) => {
      const near = typeof d?.nearGate === 'number' && d.nearGate > 0 ? d.nearGate : null;
      return near === null
        ? say('standing.gate.empty')
        : say('standing.gate.nearGate', {
            n: near,
            issues: agrees(near, 'issue', 'issues'),
            verb: agrees(near, 'stands', 'stand'),
            their: agrees(near, 'its', 'their'),
          });
    },
  },
  RELEASE_ROSTER_OVERSIZE: {
    title: 'standing.gate.title.oversize',
    plain: (d) => {
      const waiting = numberOf(d?.waiting);
      const limit = numberOf(d?.limit) ?? RELEASE_ROSTER_LIMIT;
      return waiting === null
        ? say('standing.gate.oversizeUncounted', { limit })
        : say('standing.gate.oversize', {
            n: waiting,
            issues: agrees(waiting, 'issue', 'issues'),
            verb: agrees(waiting, 'is', 'are'),
            limit,
          });
    },
  },
  RELEASE_RECORD_MISSING: {
    title: 'standing.gate.title.noteMissing',
    plain: (d) => withSubject('standing.gate.noteMissing', d, ['has', 'have']),
  },
  RELEASE_WORK_UNMERGED: {
    title: 'standing.gate.title.unmerged',
    plain: (d) => withSubject('standing.gate.unmerged', d, ['has', 'have']),
  },
  RELEASE_PROBES_UNREADABLE: {
    title: 'standing.gate.title.unprovable',
    plain: plain('standing.gate.unprovable'),
  },
  RELEASE_POOL_EMPTY: {
    title: 'standing.gate.title.noRunner',
    plain: plain('standing.gate.noRunner'),
  },
  NO_RUNNER_ONLINE: {
    title: 'standing.gate.title.noRunnerOnline',
    plain: plain('standing.gate.noRunnerOnline'),
  },
  BATCH_IN_FLIGHT: { title: 'standing.gate.title.running', plain: plain('standing.gate.running') },
  RELEASE_CRITERIA_UNEARNED: {
    title: 'standing.gate.title.unearned',
    plain: (d) =>
      say('standing.gate.unearned', { owes: owes(d, say('standing.gate.subject.atGate')) }),
  },
  RELEASE_RUNTIME_UNROUTED: {
    title: 'standing.gate.title.unreadable',
    plain: plain('standing.gate.unreadable'),
  },
  RELEASE_CHECK_UNEVALUATED: {
    title: 'standing.gate.title.unevaluated',
    plain: (d) =>
      say('standing.gate.unevaluated', {
        check: typeof d?.check === 'string' ? d.check : 'release',
      }),
  },
  RELEASE_RUNNER_PREFERENCE_UNMET: {
    title: 'standing.gate.title.preference',
    plain: plain('standing.gate.preference'),
  },
  RELEASE_CRITERIA_HELD_BACK: {
    title: 'standing.gate.title.heldBack',
    plain: (d) => {
      const n = heldOf(d).length;
      return say('standing.gate.heldBack', {
        owes: owes(d, say('standing.gate.subject.some')),
        they: agrees(n, 'It is', 'They are'),
        their: agrees(n, 'its', 'their'),
      });
    },
  },
  RELEASE_CRITERIA_UNCORROBORATED: {
    title: 'standing.gate.title.uncorroborated',
    plain: (d) => {
      if (issuesNamed(d).length === 0) {
        return say('standing.gate.uncorroborated', {
          subject: say('standing.gate.subject.some'),
          verb: 'carry',
        });
      }
      const s = subjectOf(d);
      return say('standing.gate.uncorroborated', {
        subject: s.said,
        verb: agrees(s.n, 'carries', 'carry'),
      });
    },
  },
};

const onThem =
  (key: 'standing.act.writeReleaseNote' | 'standing.act.markMerge') =>
  (d: Details): Said => {
    const s = subjectOf(d);
    return say(key, { on: s.n === 0 ? null : say('standing.gate.on', { subject: s.said }) });
  };

const act =
  (key: SaidPlainKey): Owed['act'] =>
  () =>
    say(key);

/**
 * Who clears each reason, read off what its remedy asks for. An act on the issues a reason names —
 * a release note, a merge mark, a judging run — is the project's master's, as every other act on an
 * issue at the gate is (`issues/standing.ts:releaseTurn`); the project's configuration, its boxes and
 * which issues a cut names are an admin's; a release already running and a check to retry are the
 * gate's own (F72).
 */
const OWED: Record<ReleaseReasonCode, Owed> = {
  NO_RELEASE_GATE: { by: 'admin', act: act('standing.act.declareProduction') },
  RELEASE_TARGET_UNDECLARED: { by: 'admin', act: act('standing.act.declareTarget') },
  CLAIM_CONFLICT: { by: 'admin', act: act('standing.act.cutWaiting') },
  RELEASE_ROSTER_EMPTY: { by: 'master', act: act('standing.act.bringIssueToGate') },
  RELEASE_ROSTER_OVERSIZE: {
    by: 'admin',
    act: act('standing.act.splitRelease'),
    effect: (d) => {
      const waiting = numberOf(d?.waiting);
      const limit = numberOf(d?.limit) ?? RELEASE_ROSTER_LIMIT;
      const rest = waiting === null ? null : Math.max(0, waiting - limit);
      return say('releases.effect.split', {
        limit,
        left:
          rest === null
            ? say('releases.effect.splitOthers')
            : say('releases.effect.splitRest', { n: rest }),
      });
    },
  },
  RELEASE_RECORD_MISSING: { by: 'master', act: onThem('standing.act.writeReleaseNote') },
  RELEASE_WORK_UNMERGED: { by: 'master', act: onThem('standing.act.markMerge') },
  RELEASE_PROBES_UNREADABLE: { by: 'admin', act: act('standing.act.declareProbe') },
  RELEASE_POOL_EMPTY: { by: 'admin', act: act('standing.act.pairRunner') },
  NO_RUNNER_ONLINE: { by: 'admin', act: act('standing.act.runnerOnline') },
  BATCH_IN_FLIGHT: {
    by: 'system',
    act: (d) =>
      typeof d?.version === 'string'
        ? say('standing.act.queuedBehind', { v: d.version })
        : say('standing.act.releaseRunning'),
  },
  RELEASE_CRITERIA_UNEARNED: { by: 'master', act: act('standing.act.judgeCriteria') },
  RELEASE_RUNTIME_UNROUTED: { by: 'admin', act: act('standing.act.productionReadable') },
  RELEASE_CHECK_UNEVALUATED: { by: 'system', act: act('standing.act.checkCouldNotRun') },
  RELEASE_RUNNER_PREFERENCE_UNMET: { by: 'admin', act: act('standing.act.labelRunner') },
  RELEASE_CRITERIA_HELD_BACK: { by: 'master', act: act('standing.act.judgeCriteria') },
  RELEASE_CRITERIA_UNCORROBORATED: { by: 'system', act: act('standing.act.verdictsNotReread') },
};

const OWNER_OF: Record<Exclude<Owing, 'admin'>, { kind: ReleaseGateOwner['kind']; who: Said }> = {
  master: { kind: 'agent', who: say('standing.who.master') },
  system: { kind: 'system', who: say('standing.who.releaseGate') },
};

const owner = (
  kind: ReleaseGateOwner['kind'],
  says: ReleaseGateOwner['says'],
): ReleaseGateOwner => ({
  kind,
  who: sayEn(says.who),
  act: sayEn(says.act),
  ...(says.effect ? { effect: sayEn(says.effect) } : {}),
  says,
});

// an admin's act names the project's admins, and where none holds project.admin says where it is granted
function ownerOf(
  code: ReleaseReasonCode,
  details: Details,
  admins: readonly string[],
): ReleaseGateOwner {
  const owed = OWED[code];
  const act = owed.act(details);
  const effect = owed.effect ? { effect: owed.effect(details) } : {};
  if (owed.by !== 'admin') {
    const by = OWNER_OF[owed.by];
    return owner(by.kind, { who: by.who, act, ...effect });
  }
  return owner('person', {
    who: holdersWho(admins),
    act: admins.length === 0 ? nobodyHoldsAct(act, 'project.admin') : act,
    ...effect,
  });
}

function gateView(
  entry: ReleaseBlocker | ReleaseWarning,
  kind: ReleaseGateView['kind'],
  admins: readonly string[],
): ReleaseGateView {
  const reading = READINGS[entry.code];
  const title = say(reading.title);
  const sentence = reading.plain(entry.details);
  return {
    code: entry.code,
    kind,
    title: sayEn(title),
    sentence: sayEn(sentence),
    detail: entry.message,
    issues: issuesNamed(entry.details),
    owner: ownerOf(entry.code, entry.details, admins),
    says: { title, sentence },
  };
}

/** Every blocker and warning as the gate shows it; `admins` are the names of project.admin's holders, whom an admin's act names. */
export function gateViews(
  blockers: readonly ReleaseBlocker[],
  warnings: readonly ReleaseWarning[],
  admins: readonly string[],
): ReleaseGateView[] {
  return [
    ...blockers.map((b) => gateView(b, 'blocker', admins)),
    ...warnings.map((w) => gateView(w, 'warning', admins)),
  ];
}
