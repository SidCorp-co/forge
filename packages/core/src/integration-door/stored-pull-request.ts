/**
 * Which stored change request `POST /api/issues/:id/merge-pull-request` acts on, or the refusal that
 * says why there is none. Split out of the route file, which reads and writes nothing itself.
 *
 * ISS-980 (FB-500, FB-546, FB-547): a request the projection did not hold for the issue was refused
 * NO_PULL_REQUEST for as long as nothing re-read it — opened while its create answer lacked a field,
 * retitled on the host, or linked by a rule the caller could not see. A named request the projection
 * does not hold for the issue is now read from the host once and re-projected before it is refused,
 * and the refusal says what the projection holds for it and how a request links to an issue.
 */

import {
  changeRequestLabelOf,
  describeEmptyProjection,
  heldRequestsNumbered,
  openPullRequestsForIssue,
  projectionPipeReport,
  pullRequestNumbered,
  resolveSourceHost,
} from '../integrations/source-host/index.js';
import { CHANGE_REQUEST_LINK_RULE, issueKeysAndTitles } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { promotionPinnedFor } from '../release-batch/index.js';
import { project } from './source-projection.js';

type NoRowCode = 'NO_PULL_REQUEST' | 'PROJECTION_EMPTY';
type Resolved = { id: string } | { refusal: string; code: NoRowCode };

/**
 * The refusal for an issue with no row, with the two states told apart.
 *
 * ISS-1123: `NO_PULL_REQUEST` reads as "you named the wrong number", and for the first year of this
 * route's life it was never once true — the projection had a single writer nothing reached, so
 * EVERY pull request on EVERY project answered that sentence. A projection holding nothing at all
 * is reported as what it is, under its own code, before the number is blamed.
 */
async function noRowRefusal(
  projectId: string,
  about: string,
): Promise<{ refusal: string; code: NoRowCode }> {
  const empty = describeEmptyProjection(await projectionPipeReport(projectId));
  return empty
    ? { refusal: empty, code: 'PROJECTION_EMPTY' }
    : { refusal: about, code: 'NO_PULL_REQUEST' };
}

/**
 * Read change request `number` from the project's host and write it onto the projection, by the
 * writer a refresh takes, so its links follow its branch, title and description as the host holds
 * them now. Answers how the host writes the request's number, and why the re-read failed, or null.
 */
async function reproject(
  projectId: string,
  number: number,
): Promise<{ label: string; failed: string | null }> {
  let label = `#${number}`;
  try {
    const host = await resolveSourceHost(projectId);
    label = `${host.words.sigil}${number}`;
    await project(host, projectId, await host.readChangeRequest(number));
    return { label, failed: null };
  } catch (err) {
    logger.warn(
      { projectId, number, err },
      'merge-pull-request: a named change request could not be re-read before the refusal',
    );
    return { label, failed: err instanceof Error ? err.message : String(err) };
  }
}

/** How the row's own host writes the number; the re-read's label where no provider serves it. */
function labelOn(host: string, number: number, fallback: string): string {
  try {
    return changeRequestLabelOf(host, number);
  } catch {
    return fallback;
  }
}

/** What the projection holds for the named request, said beside the issue the call named. */
async function heldSentence(args: {
  projectId: string;
  issueId: string;
  number: number;
  label: string;
  failed: string | null;
}): Promise<string> {
  const held = await heldRequestsNumbered(args.projectId, args.number);
  const keys = await issueKeysAndTitles(args.projectId, [
    args.issueId,
    ...held.flatMap((h) => h.issueIds),
  ]);
  const keyOf = (id: string) => keys.get(id)?.key ?? id;
  const asked = keyOf(args.issueId);
  const reread =
    args.failed === null
      ? 're-read from the host just now'
      : `as last projected; reading it from the host failed: ${args.failed}`;
  if (held.length === 0) {
    return `Forge holds no record of ${args.label}${args.failed === null ? '' : ` (reading it from the host failed: ${args.failed})`}.`;
  }
  return held
    .map((h) => {
      const label = labelOn(h.host, args.number, args.label);
      const links =
        h.issueIds.length === 0
          ? 'links no issue'
          : `links ${h.issueIds.map(keyOf).join(', ')}, not ${asked}`;
      return `Forge holds ${label} (branch \`${h.headRef}\`, title ${JSON.stringify(h.title)}, ${reread}), which ${links}.`;
    })
    .join(' ');
}

/** The refusal for a named request the projection does not hold for the issue, after the re-read. */
async function namedRequestRefusal(
  projectId: string,
  issueId: string,
  number: number,
  reread: { label: string; failed: string | null },
): Promise<{ refusal: string; code: NoRowCode }> {
  const held = await heldSentence({ projectId, issueId, number, ...reread });
  return noRowRefusal(
    projectId,
    `this issue has no pull request ${reread.label} on Forge's projection of the repository. ${held} ` +
      `${CHANGE_REQUEST_LINK_RULE} Name this issue in one of those places — ` +
      `\`PATCH /api/projects/${projectId}/integrations/source/change-requests/${number}\` edits its title or description and re-records it — then merge again.`,
  );
}

/** The stored pull request this call is about, or the sentence saying why there is none. */
export async function resolveStoredPullRequest(
  projectId: string,
  issueId: string,
  number: number | undefined,
): Promise<Resolved> {
  if (number !== undefined) {
    const found = async () =>
      (await pullRequestNumbered(issueId, number)) ?? (await promotionPinnedFor(issueId, number));
    const stored = await found();
    if (stored) return { id: stored };
    const reread = await reproject(projectId, number);
    const fresh = reread.failed === null ? await found() : null;
    return fresh ? { id: fresh } : namedRequestRefusal(projectId, issueId, number, reread);
  }
  const open = await openPullRequestsForIssue(issueId);
  if (open.length === 0) {
    return noRowRefusal(
      projectId,
      "this issue has no open pull request on Forge's projection of the repository — name one with " +
        `\`pullRequest\`, and Forge reads it from the host before refusing it. ${CHANGE_REQUEST_LINK_RULE}`,
    );
  }
  if (open.length > 1) {
    return {
      refusal: `this issue has ${open.length} open pull requests and Forge will not choose between them — name the one to merge with \`pullRequest\``,
      code: 'NO_PULL_REQUEST',
    };
  }
  return { id: open[0] as string };
}
