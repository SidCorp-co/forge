// A cleanup report's base held to the project's source (ISS-912): the commit the report says the run
// left is read on the project's source host, the way every kernel reader of a commit reads it.

import type { CleanupRefusalCode, CleanupReportRequest } from '@forge/contracts/cleanup';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<CleanupRefusalCode>('CLEANUP_REFUSED');

/** The words every base refusal ends with: the shape a valid base takes. */
const BASE_SHAPE =
  "A valid `base.sha` is the full 40-hex sha of a commit on `base.branch` in the project's repository: the head the cleanup run left there. Nothing was recorded";

/**
 * Hold a report's base to the project's source (ISS-912): `base.sha` is a commit on `base.branch`
 * as the project's source host reads it, or the report is refused by name. A project whose host
 * cannot be read is refused by its own name: a base is evidence that gates landing (BC-5), so it is
 * never taken on the report's word.
 */
export async function checkReportBase(projectId: string, base: CleanupReportRequest['base']) {
  const sha = base.sha.toLowerCase();
  const uncheckable = (why: string, then: string) =>
    refuse(
      'CLEANUP_BASE_UNCHECKABLE',
      `whether \`${base.branch}\` holds \`${sha}\` cannot be checked on this project, so the report is not taken on its word: ${why}. ${then} ${BASE_SHAPE}`,
      '/base/sha',
    );
  let host: SourceHost;
  try {
    host = await resolveSourceHost(projectId, 'kernel');
  } catch (err) {
    if (err instanceof SourceHostUnavailable) {
      throw uncheckable(
        err.message,
        "Bind the repository's host on the project's Integrations page, then report again.",
      );
    }
    throw err;
  }
  const where = `${host.provider} ${host.fullName}`;
  let found: 'no-commit' | 'off-branch' | null;
  try {
    const commit = await host.readCommit(sha);
    if (commit?.sha.toLowerCase() !== sha) found = 'no-commit';
    else found = (await host.branchContains(base.branch, sha)) ? null : 'off-branch';
  } catch (err) {
    throw uncheckable(
      `${where} did not answer the read: ${err instanceof Error ? err.message : String(err)}`,
      'Report again once the host answers.',
    );
  }
  if (found === null) return;
  throw refuse(
    'CLEANUP_BASE_NOT_ON_BRANCH',
    `base.sha \`${sha}\` ${found === 'no-commit' ? 'names no commit' : `is a commit that branch \`${base.branch}\` does not contain`} in ${where}. ${BASE_SHAPE}`,
    '/base/sha',
  );
}
