/**
 * ISS-705 — the issue a change-request link route names, read as this project's or refused by name.
 *
 * A link only ever joins a request to an issue of its own project, so an issue of another project is
 * the caller naming the wrong thing: by its uuid, or by a key under a prefix this project does not
 * hold (`AH-11`). Both are refused as another project's issue rather than read as "not linked".
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import {
  findIssueById,
  heldIssuePrefixes,
  issueKeysAndTitles,
  isUuid,
  resolveIssueKeyInProject,
} from '../issues/index.js';
import { issueRefPrefixOf, parseIssueRef } from '../lib/issue-ref.js';
import { refuser } from '../lib/refusal.js';
import { badRequest, notFound } from '../middleware/route-errors.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

/** Prefixes of other records' keys, which name no issue anywhere. */
const RECORD_PREFIXES = new Set(['REQ', 'FB']);

export async function changeRequestIssueOf(
  projectId: string,
  raw: string,
  requestLabel: string,
): Promise<{ id: string; key: string }> {
  const foreign = (detail: string) =>
    refuse('CHANGE_REQUEST_ISSUE_OF_ANOTHER_PROJECT', detail, '/issue');
  let id: string;
  if (isUuid(raw)) {
    const issue = await findIssueById(raw);
    if (!issue) throw notFound(`\`${raw}\` names no issue`);
    if (issue.projectId !== projectId) {
      throw foreign(
        `\`${raw}\` is an issue of another project, and ${requestLabel} links only this project's issues: name one of them`,
      );
    }
    id = issue.id;
  } else {
    const prefix = issueRefPrefixOf(raw);
    const parsed = parseIssueRef(raw, await heldIssuePrefixes(projectId));
    if (!parsed.ok) {
      if (parsed.code === 'FOREIGN_PREFIX' && prefix && !RECORD_PREFIXES.has(prefix)) {
        throw foreign(
          `${parsed.message} ${requestLabel} links only this project's issues, so another project's key is never one of its links.`,
        );
      }
      throw badRequest(parsed.message);
    }
    id = await resolveIssueKeyInProject(raw, projectId);
  }
  const key = (await issueKeysAndTitles(projectId, [id])).get(id)?.key ?? raw;
  return { id, key };
}
