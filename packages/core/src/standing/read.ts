/**
 * The one standing read (REQ-48 BC-8; docs/proposals/steward-agent.md, "Standing contract"): one row
 * per open requirement, feedback item and issue of a project, built from the same per-slice
 * derivations the lists draw, read with no viewer so every reader and the steward see one basis.
 * `GET /api/projects/:id/standings`, `forge_standing` and the steward's sweep (`OpenStandingsRead`)
 * all read it; nothing here derives a fact of its own.
 */

import { countsAsReport, type FeedbackSummary } from '@forge/contracts/feedback';
import type { IssueStandingRow } from '@forge/contracts/issue-standing';
import type { Standing } from '@forge/contracts/standing';
import type {
  ItemStanding,
  OpenStandingsRead,
  StandingSubject,
  StandingTimes,
  StewardNote,
  StewardNoteSubjectKind,
} from '@forge/contracts/steward';
import { feedbackStandingsOf } from '../feedback/index.js';
import { listIssueStanding } from '../issues/index.js';
import { requirementStandingsOf } from '../requirements/index.js';
import { currentNoteRowsOf, notesOf } from '../steward-notes/index.js';

/** What every slice's standing carries: its group, its wait and its times. */
type Sliced = Standing & { times: StandingTimes };

function itemOf(subject: StandingSubject, title: string, s: Sliced): ItemStanding {
  return {
    subject,
    title,
    group: s.attentionGroup,
    waitingOn: s.waitingOn,
    note: null,
    ...s.times,
  };
}

const open = (i: ItemStanding) => i.group !== 'done';

async function requirementItems(projectId: string): Promise<ItemStanding[]> {
  return (await requirementStandingsOf(projectId)).map((r) =>
    itemOf({ kind: 'requirement', id: r.id, key: r.key }, r.title, r.standing),
  );
}

async function feedbackItems(projectId: string, reportsOnly = false): Promise<ItemStanding[]> {
  return (await feedbackStandingsOf(projectId))
    .filter((f) => !reportsOnly || countsAsReport(f))
    .map((f: FeedbackSummary) => itemOf({ kind: 'feedback', id: f.id, key: f.key }, f.title, f));
}

async function issueItems(projectId: string): Promise<ItemStanding[]> {
  const list = await listIssueStanding(projectId, 'open', null);
  return list.issues.map((i: IssueStandingRow) =>
    itemOf({ kind: 'issue', id: i.id, key: i.key }, i.title, i.standing),
  );
}

/** Each item with its current steward note, the note marked stale where the item's basis moved. */
async function withNotes(projectId: string, items: ItemStanding[]): Promise<ItemStanding[]> {
  const rows = await currentNoteRowsOf(
    projectId,
    items.map((i) => i.subject.id),
  );
  const byId = new Map(items.map((i) => [i.subject.id, i]));
  const notes: Map<string, StewardNote> = await notesOf(
    [...rows.values()],
    (r) => byId.get(r.subjectId)?.subject.key ?? r.subjectId,
    (id) => byId.get(id)?.basis ?? null,
  );
  return items.map((i) => ({ ...i, note: notes.get(i.subject.id) ?? null }));
}

/** Every open item's standing in a project, stuck first (oldest first), then by key (BC-8). */
export const openStandings: OpenStandingsRead = async (projectId) => {
  const [requirements, feedback, issues] = await Promise.all([
    requirementItems(projectId),
    // a duplicate stands as its original does: one item for the steward and the status, the root
    feedbackItems(projectId, true),
    issueItems(projectId),
  ]);
  const items = await withNotes(projectId, [...requirements, ...feedback, ...issues].filter(open));
  return items.sort(
    (a, b) =>
      Number(b.stuck !== null) - Number(a.stuck !== null) ||
      (a.stuck?.since ?? '').localeCompare(b.stuck?.since ?? '') ||
      a.subject.key.localeCompare(b.subject.key, 'en', { numeric: true }),
  );
};

const ITEMS_OF: Record<StewardNoteSubjectKind, (projectId: string) => Promise<ItemStanding[]>> = {
  requirement: requirementItems,
  feedback: feedbackItems,
  issue: issueItems,
};

/** One requirement's, feedback item's or open issue's standing with its note, by key; null where the project holds none. */
export async function standingOfSubject(
  projectId: string,
  kind: StewardNoteSubjectKind,
  key: string,
): Promise<ItemStanding | null> {
  const items = await ITEMS_OF[kind](projectId);
  const wanted = key.trim().toUpperCase();
  const item = items.find((i) => i.subject.key.toUpperCase() === wanted || i.subject.id === key);
  if (!item) return null;
  const [noted] = await withNotes(projectId, [item]);
  return noted ?? null;
}
