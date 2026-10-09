// A requirement revision and its live criteria as the read model answers them (`read.ts`).

import type { RequirementKind } from '@forge/contracts/requirement-pictures';
import type { RequirementSpec } from '@forge/contracts/requirements';
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
  };
}
