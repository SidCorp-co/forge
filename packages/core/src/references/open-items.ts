// The open items a followed release is digested against (ISS-1252): a project's open issues with
// their module labels and its open requirements with their area. Read apart from the follow pass,
// which files and records, so neither reaches every module the other does.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { listIssues, listModulesForIssues } from '../issues/index.js';
import { listRowsOf } from '../requirements/index.js';
import type { OpenItem } from './match.js';

const OPEN_ITEMS = 500;
const OPEN_REQUIREMENT_STATUSES = new Set(['draft', 'agreed', 'in_delivery']);

/** A project's open issues and requirements, each with its module labels or area. */
export async function openItemsOf(projectId: string): Promise<OpenItem[]> {
  const listed = await listIssues(
    projectId,
    { statusNot: ISSUE_TERMINAL_STATUSES },
    { sort: 'priority:asc', limit: OPEN_ITEMS, offset: 0 },
  );
  const issueRows = listed.ok ? listed.rows : [];
  const modules = await listModulesForIssues(issueRows.map((r) => r.id));
  const issues: OpenItem[] = issueRows.map((r) => ({
    kind: 'issue',
    id: r.id,
    ref: `ISS-${r.issSeq}`,
    title: r.title,
    areas: (modules.get(r.id) ?? []).map((m) => m.name),
  }));
  const { rows, areas } = await listRowsOf(projectId);
  const requirements: OpenItem[] = rows
    .filter((r) => OPEN_REQUIREMENT_STATUSES.has(r.status))
    .map((r) => ({
      kind: 'requirement',
      id: r.id,
      ref: requirementKey(r.reqSeq),
      title: r.title,
      areas: r.areaId && areas.get(r.areaId) ? [areas.get(r.areaId) as string] : [],
    }));
  return [...issues, ...requirements];
}
