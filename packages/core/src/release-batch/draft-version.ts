// The version the draft release takes: the version rule asked about the roster waiting at the gate.
// One reader, so the draft's page, its forecast and the naming that holds its name until the cut
// agree on its number.

import { waitingIssueIds } from './queries.js';
import { formatReleaseVersion } from './version.js';
import type { VersionDecision } from './version-rule.js';
import { decideRosterVersion } from './version-store.js';

/**
 * The version a decision hands the draft. An undecided re-cut shows the version in question, and its
 * gate (`RELEASE_VERSION_UNDECIDED`) says why it cannot be cut yet; a line the rule refuses shows the
 * number it would have been, refused by its own gate at the cut.
 */
export function draftVersionOf(d: VersionDecision): string {
  return d.kind === 'exhausted' || d.kind === 'behind' ? formatReleaseVersion(d.next) : d.version;
}

/** The number the next cut takes: the version rule asked about the roster waiting at the gate. */
export async function nextDraftVersion(projectId: string): Promise<string> {
  return draftVersionOf(await decideRosterVersion(projectId, await waitingIssueIds(projectId)));
}

/** The draft's version, or null where nothing waits at the gate and so no release is drafted. */
export async function draftedVersion(projectId: string): Promise<string | null> {
  const ids = await waitingIssueIds(projectId);
  return ids.length === 0 ? null : draftVersionOf(await decideRosterVersion(projectId, ids));
}
