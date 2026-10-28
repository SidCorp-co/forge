import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import type { IssueStatus } from '../db/schema.js';
import { quotedRefusal } from '../issues/merge-record.js';
import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import type { CloseRefusal } from './releasing-recovery.js';

/** Why the close was refused, in words; the code stays in what a caller reads (ISS-1421 r39). */
function personRefusedFor(refusal: Extract<CloseRefusal, { kind: 'refused' }>): string {
  switch (refusal.code) {
    case 'OPEN_QUESTIONS':
      return 'The close was refused because the issue holds open questions.';
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
      return 'answer each open question in its "Decision waiting" card on this issue\'s page.';
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

/** Where a returned issue stands and how it closes, in the words its page uses. */
function howItCloses(destination: IssueStatus, refusal: CloseRefusal, delivered: boolean): string {
  const label = ISSUE_STATUS_LABELS[destination];
  if (destination !== RELEASE_GATE_STATUS) {
    return `The issue is at ${label}, and a person decides whether it goes back to work or into another release.`;
  }
  const back = delivered
    ? `The issue is back at ${label}, and its code went out with that release.`
    : `The issue is back at ${label}. That release recorded no promotion and no deploy, so nothing says its code is live.`;
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
  /** The run recorded a promotion or a deploy (`runRecordedDelivery`). */
  delivered: boolean;
  /** The project names no repository, so a mark may name no commit (`markCommitCheck` `claim`). */
  noRepository?: boolean | undefined;
  /** How a roster its run promoted is settled; such an issue stays claimed rather than moving. */
  held?: string | undefined;
  /** Earlier releases whose finish failed this close for the same reason, oldest first. */
  repeats?: ReadonlyArray<string | null> | undefined;
}): string {
  const { refusal, version, destination, held, repeats = [], delivered } = args;
  const named = version ? `as version ${version}` : 'with this batch';
  const finished = delivered
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
  return `${opening}${howItCloses(destination, refusal, delivered)}${quote}`;
}

/** A hand-back's reason as the comment's opening sentence: a capital, and one closing mark however
 *  the caller ended it (ISS-1421 r40 read "batch release aborted: …", r41 read "Stop!."). */
export function reasonSentence(reason: string): string {
  const said = reason.trim().replace(/[.\s]+$/, '');
  const ended = /[!?…]$/.test(said) ? said : `${said}.`;
  return `${ended.charAt(0).toUpperCase()}${ended.slice(1)}`;
}
