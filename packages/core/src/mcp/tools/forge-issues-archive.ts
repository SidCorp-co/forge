/**
 * ISS-1237 — `forge_issues` `archive` and `unarchive`: the REST routes' operation over MCP. Same
 * filter, same report, same refusals; the gate is project admin, as it is there.
 */

import {
  type ArchiveDirection,
  type IssueArchiveFilter,
  IssueArchiveRefusedError,
  type IssueArchiveReport,
  runIssueArchive,
} from '../../issues/archive.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { assertPrincipalIsAdmin, principalHookActor } from './lib.js';

export async function runArchiveAction(input: {
  direction: ArchiveDirection;
  projectId: string;
  filter: IssueArchiveFilter | undefined;
  dryRun: boolean | undefined;
  principal: McpPrincipal;
}): Promise<IssueArchiveReport> {
  await assertPrincipalIsAdmin(input.principal, input.projectId);
  if (!input.filter) {
    throw new Error(
      `BAD_REQUEST: ${input.direction} needs archiveFilter { keys?, statuses?, seqBelow?, exclude? } naming keys or statuses; send dryRun:true first to read back what it matches`,
    );
  }
  try {
    return await runIssueArchive({
      projectId: input.projectId,
      direction: input.direction,
      filter: input.filter,
      dryRun: input.dryRun === true,
      actor: principalHookActor(input.principal),
    });
  } catch (err) {
    if (err instanceof IssueArchiveRefusedError) throw new Error(`ARCHIVE_REFUSED: ${err.message}`);
    throw err;
  }
}

/** `archiveFilter` and `dryRun` sent on another action would be ignored in silence; say so. */
export function refuseStrayArchiveFields(input: {
  action: string;
  archiveFilter?: unknown;
  dryRun?: unknown;
}): void {
  if (input.action === 'archive' || input.action === 'unarchive') return;
  for (const key of ['archiveFilter', 'dryRun'] as const) {
    if (input[key] === undefined) continue;
    throw new Error(
      `BAD_REQUEST: ${key} is read only by action 'archive' and 'unarchive' (got '${input.action}')`,
    );
  }
}
