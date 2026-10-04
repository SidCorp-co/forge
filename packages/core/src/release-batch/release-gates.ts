import type { ReleaseGateView } from '@forge/contracts/releases';
import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { agrees, counted } from '../lib/plural.js';
import type { ReleaseBlocker, ReleaseReasonCode, ReleaseWarning } from './blocker-sentences.js';

type Details = Record<string, unknown> | undefined;

interface Reading {
  title: string;
  plain: (details: Details) => string;
}

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
  text: string;
  n: number;
}

function subjectOf(d: Details): Subject {
  const names = issuesNamed(d);
  if (names.length === 0) {
    const n = Array.isArray(d?.issueIds) ? d.issueIds.length : 0;
    return { text: counted(n, 'issue'), n };
  }
  const shown = names.slice(0, NAMED_AT_MOST).join(', ');
  const rest = names.length - NAMED_AT_MOST;
  return { text: rest > 0 ? `${shown} and ${rest} more` : shown, n: names.length };
}

const these = (d: Details, one: string, many: string): string => {
  const s = subjectOf(d);
  return `${s.text} ${agrees(s.n, one, many)}`;
};

const theirs = (d: Details, one: string, many: string): string => agrees(subjectOf(d).n, one, many);

const owes = (d: Details): string =>
  heldOf(d)
    .map(
      (h) =>
        `${h.displayId} owes ${agrees(h.criteria.length, 'criterion', 'criteria')} ${h.criteria.join(', ')}`,
    )
    .join('; ');

const READINGS: Record<ReleaseReasonCode, Reading> = {
  NO_RELEASE_GATE: {
    title: 'No release step',
    plain: () => 'This project ships when an issue closes, so there is no release to cut.',
  },
  RELEASE_TARGET_UNDECLARED: {
    title: 'Nowhere to land',
    plain: () =>
      'Nothing says where this project’s releases land. An admin completes its production environment in the project document.',
  },
  CLAIM_CONFLICT: {
    title: 'Issues already claimed',
    plain: (d) =>
      `${these(d, 'is', 'are')} not at the release gate, or another release already holds ${theirs(d, 'it', 'them')}. Pick the issues that are waiting.`,
  },
  RELEASE_ROSTER_EMPTY: {
    title: 'Nothing at the gate',
    plain: (d) =>
      typeof d?.nearGate === 'number' && d.nearGate > 0
        ? `No issue is waiting at the release gate. ${counted(d.nearGate, 'issue')} ${agrees(d.nearGate, 'stands', 'stand')} one step short of it, at ${agrees(d.nearGate, 'its', 'their')} test step.`
        : 'No issue is waiting at the release gate, so there is nothing to cut.',
  },
  RELEASE_ROSTER_OVERSIZE: {
    title: 'Too many issues',
    plain: () =>
      `More issues are waiting than one release carries (${RELEASE_ROSTER_LIMIT}). Cut them in parts, oldest merge first.`,
  },
  RELEASE_RECORD_MISSING: {
    title: 'Release note missing',
    plain: (d) =>
      `${these(d, 'has', 'have')} no release note, so the release would claim a ship nobody described.`,
  },
  RELEASE_WORK_UNMERGED: {
    title: 'Work not marked merged',
    plain: (d) =>
      `${these(d, 'has', 'have')} no merge Forge saw land, so nothing says ${theirs(d, 'its', 'their')} work is in this release.`,
  },
  RELEASE_PROBES_UNREADABLE: {
    title: 'Production cannot be proved',
    plain: () =>
      'Production declares no probe that identifies the source commit, so a release there could never be proved. An admin adds one to the production environment.',
  },
  RELEASE_POOL_EMPTY: {
    title: 'No runner paired',
    plain: () => 'No runner is paired to this project, so no machine can run a release.',
  },
  NO_RUNNER_ONLINE: {
    title: 'No runner can take it',
    plain: () => 'Runners are paired, and none of them can take a release right now.',
  },
  BATCH_IN_FLIGHT: {
    title: 'A release is running',
    plain: () =>
      'Another release is already running for this project. Let it finish before cutting another.',
  },
  RELEASE_CRITERIA_UNEARNED: {
    title: 'Criteria still owed',
    plain: (d) =>
      `${owes(d) || 'Issues at the gate'}. The unattended sweep carries an issue only when every criterion holds a passing verdict.`,
  },
  RELEASE_RUNTIME_UNROUTED: {
    title: 'Production cannot be read',
    plain: () =>
      'Nothing can read what production serves, so no verdict can earn an issue its place in an unattended release.',
  },
  RELEASE_CHECK_UNEVALUATED: {
    title: 'A check could not run',
    plain: (d) =>
      `The ${typeof d?.check === 'string' ? d.check : 'release'} check could not run, so this list may be missing a reason.`,
  },
  RELEASE_RUNNER_PREFERENCE_UNMET: {
    title: 'Preferred runner missing',
    plain: () =>
      'No runner carries the release label this project asks for, so the release goes to the pool it has.',
  },
  RELEASE_CRITERIA_HELD_BACK: {
    title: 'Some issues held back',
    plain: (d) =>
      `${owes(d) || 'Some issues'}. ${agrees(heldOf(d).length, 'It is', 'They are')} held back until ${agrees(heldOf(d).length, 'its', 'their')} criteria are earned; the others ship.`,
  },
  RELEASE_CRITERIA_UNCORROBORATED: {
    title: 'Verdicts not re-read',
    plain: (d) =>
      `${issuesNamed(d).length > 0 ? these(d, 'carries', 'carry') : 'Some issues carry'} a verdict earned where nothing could re-read production. It counts, and it is weaker evidence.`,
  },
};

function gateView(
  entry: ReleaseBlocker | ReleaseWarning,
  kind: ReleaseGateView['kind'],
): ReleaseGateView {
  const reading = READINGS[entry.code];
  return {
    code: entry.code,
    kind,
    title: reading.title,
    sentence: reading.plain(entry.details),
    detail: entry.message,
    issues: issuesNamed(entry.details),
  };
}

export function gateViews(
  blockers: readonly ReleaseBlocker[],
  warnings: readonly ReleaseWarning[],
): ReleaseGateView[] {
  return [
    ...blockers.map((b) => gateView(b, 'blocker')),
    ...warnings.map((w) => gateView(w, 'warning')),
  ];
}
