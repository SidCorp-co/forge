// What landed on the base since the project's last cleanup report (ISS-1050, REQ-79 BC-20): the
// trigger that has a window review what the delivery runs landed even where no debt was recorded.
// It reaches only as far as the window: where none is on (none saved, or one a person disabled) it
// reads nothing and starts nothing, and it never makes or enables one (ISS-1049). The base head is
// read on the project's source host, as a report's base is (`report-base.ts`).

import { db } from '../db/client.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { readLandingBranches } from '../project-config/index.js';
import { readCleanupWindow } from '../schedules/index.js';
import type { Landed } from './rules.js';
import { lastReport } from './store.js';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The range that landed on the base since the last cleanup report on it, where the window is on. */
export async function landedSinceReport(projectId: string): Promise<Landed> {
  const window = await readCleanupWindow(projectId);
  if (!window?.enabled) {
    return {
      kind: 'off',
      why: 'no cleanup window is on here to review what landed',
    };
  }
  const { defaultBranch: branch } = await readLandingBranches(projectId);
  if (!branch) {
    return {
      kind: 'unread',
      why: "the project document names no branch its work lands on, so what landed since the last cleanup report cannot be read; name it (source.git.defaultBranch in the project's document)",
    };
  }
  let head: string;
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    head = (await host.branchHead(branch)).toLowerCase();
  } catch (err) {
    return {
      kind: 'unread',
      why: `the head of ${branch} could not be read on the project's source host (${message(err).slice(0, 300)}), so what landed since the last cleanup report is unknown; bind the repository's host on the project's Integrations page, or run the cleanup by hand`,
    };
  }
  const last = await lastReport(db, projectId, branch);
  if (last && last.sha.toLowerCase() === head) return { kind: 'none', branch, head };
  return { kind: 'landed', branch, from: last?.sha.toLowerCase() ?? null, head };
}
