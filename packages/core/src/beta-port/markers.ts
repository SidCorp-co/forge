// The pure half of the beta port (ISS-923, ISS-982): the line a ported item opens with, the comment
// that marks a beta issue ported, how either is recognised, which beta status a dev status mirrors
// to, and the one order of progress both vocabularies are read in, which no mirror moves back along.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type {
  PeerLanding,
  PeerMergeMark,
  PeerReleaseNote,
} from '../integrations/peer-forge/index.js';

/**
 * How far an issue's work has come, in both vocabularies: forge-dev's ten statuses and the
 * seventeen-status model forge-beta still runs (`developed`, `testing`, `tested`, `releasing`, …).
 * This is the one order the beta port reads (ISS-982): what it leaves on beta and what the mirror
 * holds. 0 is not started; 1 is in flight, parked or dropped without landing; 2 is landed; 3 is
 * landed and waiting on a release; 4 is closed. A status it does not name is 0, so it never holds a
 * move it cannot place.
 */
export const BETA_PORT_PROGRESS: Readonly<Record<string, number>> = {
  in_progress: 1,
  needs_info: 1,
  on_hold: 1,
  dropped: 1,
  developed: 2,
  testing: 2,
  tested: 2,
  releasing: 3,
  awaiting_release: 3,
  closed: 4,
};

/** Where a status stands in `BETA_PORT_PROGRESS`. */
export function progressOf(status: string): number {
  return BETA_PORT_PROGRESS[status] ?? 0;
}

/** Whether a status says the work has landed: `developed` or later. */
export function hasLanded(status: string): boolean {
  return progressOf(status) >= progressOf('developed');
}

/** Whether moving beta from `betaStatus` to `target` would move it backward: the mirror never does. */
export function movesBackward(betaStatus: string, target: string): boolean {
  return progressOf(target) < progressOf(betaStatus);
}

/** The beta statuses that are never ported and never named: the issue was dropped there. */
export const UNPORTED_BETA_STATUSES: ReadonlySet<string> = new Set<string>(['dropped']);

/**
 * Why a beta issue is left on beta rather than ported (ISS-982 criterion 2): its work is in flight
 * there (`in_progress`) or has landed (a merge mark, or `developed` or later); null where it waits.
 */
export function leftOnBeta(beta: { status: string; marked: boolean | null }): string | null {
  if (beta.marked === true) return `${beta.status}, merge-marked`;
  if (beta.status === 'in_progress' || hasLanded(beta.status)) return beta.status;
  return null;
}

/** The first line of a ported dev issue's description. */
export function portedFirstLine(betaKey: string, betaIssueId: string): string {
  return `Ported from forge-beta ${betaKey} (${betaIssueId}).`;
}

/**
 * A ported dev issue's description: the provenance line first, which the "never twice" guard reads
 * (`firstLineNamesBetaIssue`), then a blank line and the beta body as its reporter wrote it; the
 * provenance line alone where beta's body is empty.
 */
export function portedDescription(
  betaKey: string,
  betaIssueId: string,
  body: string | null | undefined,
): string {
  const text = body?.trim();
  return [portedFirstLine(betaKey, betaIssueId), ...(text ? ['', text] : [])].join('\n');
}

/** Where a person opens the beta issue: its page on forge-beta's web origin, never its API host. */
export function betaIssueLink(webUrl: string, betaSlug: string, betaIssueId: string): string {
  return `${webUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(betaSlug)}/issues/${betaIssueId}`;
}

/**
 * A beta issue ported as Feedback (ISS-982): the provenance line first, as a ported issue opens, then
 * the link to the beta issue where beta's web origin is known, then a blank line and the beta body as
 * its reporter wrote it.
 */
export function portedFeedbackBody(
  beta: { key: string; id: string },
  link: string | null,
  body: string | null | undefined,
): string {
  const text = body?.trim();
  return [
    portedFirstLine(beta.key, beta.id),
    ...(link ? [`Beta: ${link}`] : []),
    ...(text ? ['', text] : []),
  ].join('\n');
}

/** The dedup key a ported Feedback item is filed under: one item per beta issue, whatever fails after. */
export function portedFeedbackDedupKey(betaIssueId: string): string {
  return `forge-beta:${betaIssueId}`;
}

/** The feedback key a marker or a key names, where it is one (`FB-12`); null for an issue key. */
export function feedbackSeqOf(key: string): number | null {
  const seq = /^FB-(\d{1,9})$/i.exec(key)?.[1];
  return seq ? Number(seq) : null;
}

/** The log comment a beta issue gets when it follows the dev issue a ported Feedback led to. */
export function feedbackMirroredComment(
  devKeys: readonly string[],
  feedbackKey: string,
  devStatus: string,
): string {
  return `forge-dev ${devKeys.join(', ')} (from ${feedbackKey}) reached ${devStatus}; this issue follows it.`;
}

/** A ported Feedback item's triage outcome that moves no beta status, as beta is told it once. */
export type FeedbackTold = 'requirement' | 'answer' | 'declined' | 'duplicate';

/** The one comment a beta issue gets for a triage outcome that moves no status. */
export function feedbackToldComment(
  feedbackKey: string,
  told: FeedbackTold,
  answer: string | null,
): string {
  const said = answer?.trim();
  switch (told) {
    case 'requirement':
      return `forge-dev ${feedbackKey} was routed to a requirement; its work is planned there. This issue's status is not moved.`;
    case 'answer':
      return `forge-dev ${feedbackKey} was answered${said ? `: ${said}` : '.'} This issue's status is not moved.`;
    case 'declined':
      return `forge-dev ${feedbackKey} was declined. This issue's status is not moved.`;
    case 'duplicate':
      return `forge-dev ${feedbackKey} duplicates another item; its work is followed there. This issue's status is not moved.`;
  }
}

/**
 * Whether a dev description is the provenance line and nothing else, trailing whitespace aside:
 * what a port wrote when it read no body. Anything else may be a person's edit and is never
 * backfilled.
 */
export function isPortStub(
  description: string | null,
  betaKey: string,
  betaIssueId: string,
): boolean {
  return (description ?? '').trimEnd() === portedFirstLine(betaKey, betaIssueId);
}

/** The comment written on beta once its issue is ported. */
export function portedComment(devKey: string): string {
  return `Ported to forge-dev: ${devKey}`;
}

// a marker is a comment's own first non-empty line, never the phrase quoted or explained in prose
// (ISS-1045: a beta master's prose quoting the phrase held sidpeak beta ISS-626 unported)
const MARKER_LINE = /^ported to forge-dev(?![A-Za-z0-9-])/i;
const MARKER_KEY = /^ported to forge-dev:?\s*([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9-])/i;

/** The first non-empty line of a comment, trimmed: the only line a port marker is read from. */
function markerLineOf(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}

/**
 * Whether a beta comment marks its issue ported, by hand or by this sweep: its first non-empty line
 * starts with "Ported to forge-dev", with a key after it or none.
 */
export function isPortedMarker(body: string): boolean {
  return MARKER_LINE.test(markerLineOf(body));
}

/** The dev key a marker comment's first line names directly after the phrase, where it names one. */
export function markerDevKey(body: string): string | null {
  return MARKER_KEY.exec(markerLineOf(body))?.[1]?.toUpperCase() ?? null;
}

/** The line a hand marker is written as, named to a person whose marker carries no readable key. */
export const MARKER_LINE_TO_WRITE = '`Ported to forge-dev: <ISS-n|FB-n>`';

/** The first line of a description, as stored. */
export function firstLineOf(description: string | null): string {
  return (description ?? '').split(/\r?\n/, 1)[0] ?? '';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a dev issue's first line names this beta issue: its id anywhere, or its key as a whole
 * word on a line that also says forge-beta (a key alone names an issue on any instance).
 */
export function firstLineNamesBetaIssue(
  firstLine: string,
  beta: { id: string; key: string },
): boolean {
  const line = firstLine.toLowerCase();
  if (line.includes(beta.id.toLowerCase())) return true;
  if (!line.includes('forge-beta')) return false;
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(beta.key)}(?![0-9])`, 'i').test(firstLine);
}

/**
 * The beta status each dev status mirrors to, by its own name. Beta may also stand at older names no
 * dev status takes (`developed`, `testing`, …), which the mirror reads only to order its moves
 * (`BETA_PORT_PROGRESS`). `draft` is not mirrored, because a dev issue held at draft by its ready
 * check says nothing about the work beta should record. Whether beta takes the edge is beta's: a
 * move it refuses is commented there by code, never forced.
 */
export const DEV_TO_BETA_STATUS: Readonly<Record<IssueStatus, string | null>> = {
  draft: null,
  open: 'open',
  reopen: 'reopen',
  in_progress: 'in_progress',
  approved: 'approved',
  needs_info: 'needs_info',
  on_hold: 'on_hold',
  awaiting_release: 'awaiting_release',
  closed: 'closed',
  dropped: 'dropped',
};

/** The beta status a dev status mirrors to, or null where it mirrors to none. */
export function mirrorTarget(devStatus: string): string | null {
  return (DEV_TO_BETA_STATUS as Record<string, string | null>)[devStatus] ?? null;
}

/** The reason a mirrored move carries on beta. */
export function mirrorReason(devKey: string, devStatus: string): string {
  return `Mirrored from forge-dev ${devKey}, which moved to ${devStatus}.`;
}

/** The one comment a refused mirror move leaves on beta. */
export function mirrorRefusedComment(devKey: string, devStatus: string, code: string): string {
  return `forge-dev ${devKey} moved to ${devStatus}; forge-beta refused the matching move: ${code}.`;
}

/**
 * Where a dev issue's work landed, as beta's merge mark records it: the dev key and the landing the
 * dev issue's own mark names (its landing, else its commit).
 */
export function devLanding(dev: {
  key: string;
  mergedLanding: string | null;
  mergedCommitSha: string | null;
}): string {
  const where = dev.mergedLanding
    ? ` at ${dev.mergedLanding}`
    : dev.mergedCommitSha
      ? ` at commit ${dev.mergedCommitSha.slice(0, 12)}`
      : '';
  return `forge-dev ${dev.key}${where}`;
}

/** The note beta's merge mark carries: the work was done and shipped on forge-dev. */
export function landedNote(devKey: string): string {
  return `Worked and shipped on forge-dev as ${devKey}; beta records its status (owner ruling beta-issues-are-worked-on-dev).`;
}

/**
 * Beta's merge mark for a dev issue, in the shape the beta twin project's landing takes, and how the
 * report words it. In git: the dev issue's merged commit, on the branch the beta project lands on,
 * at the dev issue's merged time, never a `landing`, which beta refuses there (LANDING_NOT_THIS_SHAPE).
 * Outside git: the `landing` naming the dev key and where its work landed. A git twin's dev issue
 * holding no merged commit is refused by name: a commit is never guessed.
 */
export function landingMark(
  dev: {
    key: string;
    mergedLanding: string | null;
    mergedCommitSha: string | null;
    mergedAt: Date | null;
  },
  landing: PeerLanding,
): { ok: true; mark: PeerMergeMark; says: string } | { ok: false; refusal: string } {
  const note = landedNote(dev.key);
  if (landing.shape === 'outside_git') {
    return {
      ok: true,
      mark: { landing: devLanding(dev), note },
      says: `its landing recorded as ${devLanding(dev)}`,
    };
  }
  if (!dev.mergedCommitSha) {
    return {
      ok: false,
      refusal: `BETA_PORT_NO_MERGED_COMMIT: ${dev.key} holds no merged commit, and the beta project lands in git, so a mark names a commit and none was sent`,
    };
  }
  return {
    ok: true,
    mark: {
      commit: dev.mergedCommitSha,
      target: landing.target,
      mergedAt: dev.mergedAt?.toISOString() ?? null,
      note,
    },
    says: `its landing recorded as commit ${dev.mergedCommitSha.slice(0, 12)} on ${landing.target}`,
  };
}

/** The reason a move to the nearest legal status toward closed carries on beta. */
export function nearestReason(devKey: string, refused: string): string {
  return `Mirrored from forge-dev ${devKey}, which moved to closed; forge-beta refused closed (${refused}), and this is the nearest status toward it that it takes.`;
}

/**
 * Whether a pair owes beta a try of the dev status. A pair tried under this rule is tried once per dev
 * status, but a close: one beta has not taken is tried again at every fire while beta stands where
 * the last try left it (`retry-close`, ISS-1005), until beta closes it, since beta closes an issue only
 * by a release whose record it may refuse for a while; a beta issue a person moved since is left as
 * they moved it. One tried under the old rule (no `lastTriedStatus`) recorded the dev status as
 * mirrored whether beta took it or not; where beta does not stand at that status's target, beta
 * refused it, and it is tried once more under this rule.
 */
export function owesTry(
  pair: {
    lastMirroredStatus: string | null;
    lastTriedStatus: string | null;
    betaReached: string | null;
  },
  devStatus: string,
  betaStatus: string,
): 'try' | 'retry-old' | 'retry-close' | null {
  if (pair.lastTriedStatus !== null) {
    if (devStatus !== pair.lastTriedStatus) return 'try';
    const closeOwed =
      devStatus === 'closed' && betaStatus !== 'closed' && betaStatus === pair.betaReached;
    return closeOwed ? 'retry-close' : null;
  }
  if (devStatus !== pair.lastMirroredStatus) return 'try';
  const target = mirrorTarget(devStatus);
  return target !== null && target !== betaStatus ? 'retry-old' : null;
}

/** A dev release, as the beta record of it names it: its version and the commit it shipped. */
export interface ReleaseNamed {
  version: string;
  commit: string | null;
}

/** The account a beta release record of a dev release carries: what shipped, where, and why here. */
export function releaseRecordAccount(
  twinSlug: string,
  devKey: string,
  release: ReleaseNamed,
): string {
  const at = release.commit ? ` at commit ${release.commit}` : '';
  return `forge-dev released ${twinSlug} ${release.version}${at}, carrying ${devKey}. The work was done and shipped on forge-dev; the beta port records that release here (owner ruling beta-issues-are-worked-on-dev).`;
}

/** The handle a beta release record carries for a dev release: the version it shipped as. */
export function releaseRecordRef(twinSlug: string, release: ReleaseNamed): string {
  return `forge-dev ${twinSlug} ${release.version}`;
}

/**
 * The one comment a close beta refused leaves on the beta issue: the dev release that closed its
 * twin, where one did, and every refusal met, by name.
 */
export function closeRefusedComment(
  devKey: string,
  release: ReleaseNamed | null,
  codes: string,
): string {
  const how = release ? ` by its release ${release.version}` : '';
  return `forge-dev ${devKey} was closed${how}; forge-beta refused to close this issue to match: ${codes}. The beta port keeps trying at every fire until it closes.`;
}

/** The release note a beta issue is given from its dev twin's, in the fields beta's note takes. */
export function betaReleaseNote(dev: {
  releaseNotes: {
    section: string;
    userFacing: string;
    technical?: string | null | undefined;
  } | null;
}): PeerReleaseNote | null {
  const note = dev.releaseNotes;
  if (!note) return null;
  return { section: note.section, userFacing: note.userFacing, technical: note.technical ?? null };
}
