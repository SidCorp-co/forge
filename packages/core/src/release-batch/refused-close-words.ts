import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import type { IssueStatus } from '../db/schema.js';
import { quotedRefusal } from '../issues/merge-record.js';
import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import type { CloseRefusal } from './releasing-recovery.js';

/** What a run's promotions and deploys reported: one that went out decides over failed or unsettled
 *  ones, and one declared that never said it went out is no delivery (ISS-1421 r42). */
export type RunDelivery = 'reported' | 'unreported' | 'none';

/** How many open questions a refusal names; none named reads as more than one. */
function openQuestions(refusal: Extract<CloseRefusal, { kind: 'refused' }>): number {
  return refusal.blocking.filter((named) => named.startsWith('open question ')).length;
}

/** Why the close was refused, in words; the code stays in what a caller reads (ISS-1421 r39). */
function personRefusedFor(refusal: Extract<CloseRefusal, { kind: 'refused' }>): string {
  switch (refusal.code) {
    case 'OPEN_QUESTIONS':
      return openQuestions(refusal) === 1
        ? 'The close was refused because the issue holds an open question.'
        : 'The close was refused because the issue holds open questions.';
    case 'CLOSE_REQUIRES_SHIPPED':
      return 'The close was refused because the issue is not marked merged.';
    case 'STALE_TRANSITION':
      return 'The close was refused because the issue changed while the release was closing it.';
    default:
      return 'The close was refused.';
  }
}

/** What clears a refusal, as an act the issue's page offers at the release gate, Mark merged's own
 *  steps included; a code with none keeps its own detail (ISS-1381 r3, ISS-1421 r41). */
function personClears(
  refusal: Extract<CloseRefusal, { kind: 'refused' }>,
  noRepository: boolean,
): string {
  switch (refusal.code) {
    case 'OPEN_QUESTIONS':
      return openQuestions(refusal) === 1
        ? 'answer the open question in its "Decision waiting" card on this issue\'s page.'
        : 'answer each open question in its "Decision waiting" card on this issue\'s page.';
    case 'CLOSE_REQUIRES_SHIPPED': {
      const steps = markMergedSteps(refusal.outsideGit, noRepository);
      return `${steps.charAt(0).toLowerCase()}${steps.slice(1)}`;
    }
    case 'STALE_TRANSITION':
      return 'nothing; the issue changed while the release was closing it. Read where it stands now.';
    default:
      return refusal.detail;
  }
}

/** Whether this issue's code went out with the release: only where a delivery reported going out
 *  AND the issue's mark says where its work landed. A refusal for the mark says it does not, whatever
 *  the column holds (ISS-1421 r42, judge-169 on 398). */
function whatWentOut(
  label: string,
  refusal: CloseRefusal,
  delivery: RunDelivery,
  marked: boolean,
): string {
  if (delivery === 'none') {
    return `The issue is back at ${label}. That release recorded no promotion and no deploy, so nothing says its code is live.`;
  }
  if (delivery === 'unreported') {
    return `The issue is back at ${label}. No promotion or deploy of that release reported going out, so nothing says its code is live.`;
  }
  const unlanded = refusal.kind === 'refused' && refusal.code === 'CLOSE_REQUIRES_SHIPPED';
  if (marked && !unlanded) {
    return `The issue is back at ${label}, and its code went out with that release.`;
  }
  const missing = marked
    ? 'Its mark does not say where its work landed'
    : 'It is not marked merged';
  return `The issue is back at ${label}. ${missing}, so nothing says its code went out with that release.`;
}

/** Where a returned issue stands and how it closes, in the words its page uses. */
function howItCloses(
  destination: IssueStatus,
  refusal: CloseRefusal,
  delivery: RunDelivery,
  marked: boolean,
): string {
  const label = ISSUE_STATUS_LABELS[destination];
  if (destination !== RELEASE_GATE_STATUS) {
    return `The issue is at ${label}, and a person decides whether it goes back to work or into another release.`;
  }
  const back = whatWentOut(label, refusal, delivery, marked);
  // No reading here says a database fault cleared, so Release now stays on offer and says what it
  // meets until then (ISS-1381 r4).
  if (refusal.kind === 'failed') {
    return (
      `${back} The release banner on this page offers Release now, and a release started there ` +
      'fails the same way until that failure is fixed. Once it is, Release now starts a release ' +
      'that closes it; or leave it there and the next release closes it.'
    );
  }
  return (
    `${back} Once the reason above is cleared, the release banner on this page offers Release now, ` +
    'which starts a release that closes it; or leave it there and the next release closes it.'
  );
}

/** "1 blocking run, 2 open questions": a person is told what blocks, never the ids a caller reads. */
function countedBlockers(blocking: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const named of blocking) {
    const label = named.slice(0, named.lastIndexOf(' '));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}${n === 1 ? '' : 's'}`).join(', ');
}

/** "version 1.4.0, one with no version": the releases a repeated failure came from. */
function releasesNamed(versions: ReadonlyArray<string | null>): string {
  return versions.map((v) => (v ? `version ${v}` : 'one with no version')).join(', ');
}

/** The whole comment: `docs/modules/release/release-batch.md` says what each part holds. */
export function refusedCloseComment(args: {
  refusal: CloseRefusal;
  projectId: string;
  version: string | null;
  destination: IssueStatus;
  /** What the run's promotions and deploys reported (`runDelivery`). */
  delivery: RunDelivery;
  /** The issue holds a merge mark. */
  marked: boolean;
  /** The project names no repository, so a mark may name no commit (`markCommitCheck` `claim`). */
  noRepository?: boolean | undefined;
  /** How a roster its run promoted is settled; such an issue stays claimed rather than moving. */
  held?: string | undefined;
  /** Earlier releases whose finish failed this close for the same reason, oldest first. */
  repeats?: ReadonlyArray<string | null> | undefined;
}): string {
  const { refusal, version, destination, held, repeats = [], delivery, marked } = args;
  const named = version ? `as version ${version}` : 'with this batch';
  const finished =
    delivery === 'reported'
      ? `The release finished and went out ${named}`
      : `The release finished${version ? ` ${named}` : ''}`;
  const blocking =
    refusal.kind === 'refused' && refusal.blocking.length > 0
      ? ` Blocking it: ${countedBlockers(refusal.blocking)}.`
      : '';
  const why =
    refusal.kind === 'refused'
      ? `${personRefusedFor(refusal)}${blocking} What clears it: ${personClears(refusal, args.noRepository === true)}`
      : 'The close failed inside Forge before it reached a decision. Nothing on this issue refused it, so nothing here is yours to clear: whoever operates this Forge fixes it, and what Forge said is quoted at the end.';
  const before =
    repeats.length > 0
      ? ` The release${repeats.length === 1 ? '' : 's'} before it (${releasesNamed(repeats)}) could not close it for the same reason either.`
      : '';
  const opening = `${finished}, but this issue could not be closed.${before} ${why}\n\n`;
  const quote = refusal.kind === 'failed' ? `\n\n${quotedRefusal(refusal.message)}` : '';
  if (held) {
    const again = refusal.kind === 'refused' ? 'refused' : 'failed';
    return `${opening}${held} Clear the reason above first, or that close is ${again} again.${quote}`;
  }
  return `${opening}${howItCloses(destination, refusal, delivery, marked)}${quote}`;
}

/** A hand-back's reason as the comment's opening sentence: a capital, and one closing mark however
 *  the caller ended it (ISS-1421 r40 read "batch release aborted: …", r41 read "Stop!."); an
 *  ellipsis is the writer's own mark and stays (r42 read "Hold on..." as "Hold on."). */
export function reasonSentence(reason: string): string {
  const trimmed = reason.trim();
  const said = /(\.{3,}|…)$/.test(trimmed) ? trimmed : trimmed.replace(/[.\s]+$/, '');
  const ended = /([!?…]|\.{3,})$/.test(said) ? said : `${said}.`;
  return `${ended.charAt(0).toUpperCase()}${ended.slice(1)}`;
}
