// A requirement revision and its live criteria as the read model answers them (`read.ts`).

import type { RequirementKind } from '@forge/contracts/requirement-pictures';
import type { RequirementCriteriaChanges, RequirementSpec } from '@forge/contracts/requirements';
import type {
  CriterionForm,
  RevisionState,
  requirementCriteria,
  requirementRevisions,
} from '../db/schema-requirements.js';
import type { Person } from '../lib/people.js';
import { type PictureRow, pictureView } from './picture-read.js';
import { liveAt } from './rules.js';

export type RevisionRow = typeof requirementRevisions.$inferSelect;
export type CriterionRow = typeof requirementCriteria.$inferSelect;

export const criterionView = (c: CriterionRow) => ({
  id: c.id,
  code: c.code,
  body: c.body,
  form: c.form as CriterionForm,
  sinceRevision: c.sinceRevision,
  retiredRevision: c.retiredRevision,
});

function pictureOf(
  id: string | null,
  pictures: readonly PictureRow[],
  people: ReadonlyMap<string, Person>,
) {
  const shown = id === null ? undefined : pictures.find((p) => p.id === id);
  return shown ? pictureView(shown, people) : null;
}

const byCode = (a: string, b: string) => Number(a.slice(3)) - Number(b.slice(3));

/**
 * The codes `revision` added, reworded and retired against `base` (REQ-34 r2 BC-7): a code live at
 * the revision and not at its base was added; one live at both on another row was reworded; one live
 * at the base and not at the revision was removed. Null where the revision has no base.
 */
export function criteriaChangesOf(
  criteria: readonly CriterionRow[],
  revision: number,
  base: number | null,
): RequirementCriteriaChanges | null {
  if (base === null) return null;
  const was = new Map(liveAt(criteria, base).map((c) => [c.code, c.id]));
  const now = new Map(liveAt(criteria, revision).map((c) => [c.code, c.id]));
  return {
    against: base,
    added: [...now.keys()].filter((code) => !was.has(code)).sort(byCode),
    changed: [...now]
      .filter(([code, id]) => was.has(code) && was.get(code) !== id)
      .map(([code]) => code)
      .sort(byCode),
    removed: [...was.keys()].filter((code) => !now.has(code)).sort(byCode),
  };
}

export function revisionView(
  r: RevisionRow,
  criteria: readonly CriterionRow[],
  people: ReadonlyMap<string, Person>,
  pictures: readonly PictureRow[],
) {
  const name = (id: string | null) => (id === null ? null : (people.get(id)?.name ?? null));
  return {
    revision: r.revision,
    state: r.state as RevisionState,
    baseRevision: r.baseRevision,
    spec: r.spec as RequirementSpec,
    tldr: r.tldr,
    changeSummary: r.changeSummary,
    reason: r.reason,
    authorId: r.authorId,
    authorName: name(r.authorId),
    authorKind: people.get(r.authorId)?.kind ?? ('human' as const),
    createdAt: r.createdAt.toISOString(),
    proposedAt: r.proposedAt?.toISOString() ?? null,
    decidedBy: r.decidedBy,
    decidedByName: name(r.decidedBy),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    returnReason: r.returnReason,
    acceptReason: r.acceptReason,
    fromSuggestionId: r.fromSuggestionId,
    writtenLang: r.writtenLang,
    kind: (r.kind as RequirementKind | null) ?? null,
    picture: pictureOf(r.pictureId, pictures, people),
    criteria: liveAt(criteria, r.revision).map(criterionView),
    criteriaChanges: criteriaChangesOf(criteria, r.revision, r.baseRevision),
  };
}
