// The pure half of the beta port (ISS-923): the line a ported issue opens with, the comment that
// marks a beta issue ported, how either is recognised, and which beta status a dev status mirrors to.

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';

/** The beta statuses that are never ported: the issue is finished there. */
export const UNPORTED_BETA_STATUSES: ReadonlySet<string> = new Set<string>(ISSUE_TERMINAL_STATUSES);

/** The first line of a ported dev issue's description. */
export function portedFirstLine(betaKey: string, betaIssueId: string): string {
  return `Ported from forge-beta ${betaKey} (${betaIssueId}).`;
}

/** The comment written on beta once its issue is ported. */
export function portedComment(devKey: string): string {
  return `Ported to forge-dev: ${devKey}`;
}

const MARKER = /ported to forge-dev/i;
const MARKER_KEY = /ported to forge-dev:?\s*([A-Za-z][A-Za-z0-9]*-\d+)/i;

/** Whether a beta comment marks its issue ported, by hand or by this sweep (any key after it). */
export function isPortedMarker(body: string): boolean {
  return MARKER.test(body);
}

/** The dev key a marker comment names, where it names one. */
export function markerDevKey(body: string): string | null {
  return MARKER_KEY.exec(body)?.[1]?.toUpperCase() ?? null;
}

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
 * The beta status each dev status mirrors to. Beta runs the same ten-status machine, so a status is
 * mirrored by its own name; `draft` is not mirrored, because a dev issue held at draft by its ready
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

/** The reason a move to the nearest legal status toward closed carries on beta. */
export function nearestReason(devKey: string, refused: string): string {
  return `Mirrored from forge-dev ${devKey}, which moved to closed; forge-beta refused closed (${refused}), and this is the nearest status toward it that it takes.`;
}
