/**
 * The intake assistant's draft written into a requirement's open draft (REQ-34 BC-4, BC-13;
 * Requirement lifecycle r15 `draft`): only what the draft still leaves empty is filled, so a word the
 * author already wrote is never replaced, and each answer filled is added to the draft's assumptions
 * naming the record it came from. Nobody has to confirm it; the author corrects the draft as any
 * draft is corrected. The author stays the revision's author.
 */

import type { INTAKE_FIELDS } from '@forge/contracts/intake-drafts';
import type {
  RequirementAssumption,
  RequirementRefusalCode,
  RequirementSpec,
} from '@forge/contracts/requirements';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type RevisionState,
  requirementCriteria,
  requirementRevisions,
} from '../db/schema-requirements.js';
import { dataPolicyOf, storedDeep, storedText } from '../lib/data-egress.js';
import { writeCriteria } from './revision-criteria.js';
import { openRevisionOf } from './revision-write.js';
import { stateRefusal } from './rules.js';
import { inTx, lockRequirements, revisionWhere } from './write-tx.js';

/** The requirement answers a draft fills, as the intake contract declares them. */
export type DraftGapField = (typeof INTAKE_FIELDS)['requirement'][number];

export interface DraftGapFill {
  field: DraftGapField;
  value: string;
  /** The record it was taken from, by key. */
  source: string;
}

export type DraftGapsOutcome =
  | { ok: true; revision: number; fields: DraftGapField[] }
  | { ok: false; code: RequirementRefusalCode; detail: string };

const LABEL: Record<DraftGapField, string> = {
  summary: 'Summary',
  goal: 'Goal',
  persona: 'Persona',
  in_scope: 'In scope',
  out_of_scope: 'Out of scope',
  criterion: 'Criterion',
};

const empty = (v: string | null | undefined) => !v?.trim();
const none = (v: readonly unknown[] | undefined) => !v?.length;

/** Which fields of the draft are still gaps: an empty text, an empty list, no criterion at all. */
export function draftGapsOf(
  draft: { tldr: string | null; spec: RequirementSpec },
  liveCriteria: number,
): Set<DraftGapField> {
  const gaps = new Set<DraftGapField>();
  if (empty(draft.tldr)) gaps.add('summary');
  if (empty(draft.spec.goal)) gaps.add('goal');
  if (none(draft.spec.personas)) gaps.add('persona');
  if (none(draft.spec.scopeIn)) gaps.add('in_scope');
  if (none(draft.spec.scopeOut)) gaps.add('out_of_scope');
  if (liveCriteria === 0) gaps.add('criterion');
  return gaps;
}

/** The draft with the fills that land on a gap applied, and each of them stated as an assumption. */
export function withGapsFilled(
  draft: { tldr: string | null; spec: RequirementSpec },
  gaps: ReadonlySet<DraftGapField>,
  fills: readonly DraftGapFill[],
): { tldr: string | null; spec: RequirementSpec; criteria: string[]; fields: DraftGapField[] } {
  const landed = fills.filter((f) => gaps.has(f.field));
  const of = (field: DraftGapField) => landed.filter((f) => f.field === field).map((f) => f.value);
  const first = (field: DraftGapField) => of(field)[0];
  const spec: RequirementSpec = { ...draft.spec };
  const goal = first('goal');
  if (goal !== undefined) spec.goal = goal;
  if (of('persona').length) spec.personas = of('persona');
  if (of('in_scope').length) spec.scopeIn = of('in_scope');
  if (of('out_of_scope').length) spec.scopeOut = of('out_of_scope');
  // a single-valued field takes its first fill, so only that one is stated as assumed
  const stated = landed.filter(
    (f) => !(f.field === 'summary' || f.field === 'goal') || f.value === first(f.field),
  );
  const assumed: RequirementAssumption[] = stated.map((f) => ({
    text: `${LABEL[f.field]}: ${f.value}`.slice(0, 2_000),
    owner: 'BA assistant',
    confirmBy: 'The author corrects the draft where it is wrong',
    source: f.source,
    field: f.field,
    value: f.value.slice(0, 2_000),
  }));
  if (assumed.length) spec.assumptions = [...(draft.spec.assumptions ?? []), ...assumed];
  return {
    tldr: first('summary') ?? draft.tldr,
    spec,
    criteria: of('criterion'),
    fields: [...new Set(stated.map((f) => f.field))],
  };
}

/**
 * Fills the gaps of `requirementId`'s open draft under the project's requirement lock. Refused by
 * name, writing nothing, when the requirement holds no draft revision (it was proposed or agreed
 * before the draft came back).
 */
export async function fillDraftGaps(input: {
  projectId: string;
  requirementId: string;
  fills: readonly DraftGapFill[];
}): Promise<DraftGapsOutcome> {
  const { projectId, requirementId } = input;
  const level = await dataPolicyOf(projectId);
  let out: DraftGapsOutcome = { ok: false, code: 'REQUIREMENT_REVISION_NOT_DRAFT', detail: '' };
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const open = await openRevisionOf(tx, requirementId);
    if (!open) {
      out = {
        ok: false,
        code: 'REQUIREMENT_REVISION_NOT_DRAFT',
        detail: 'the requirement holds no draft revision, so the draft was not written into it',
      };
      return null;
    }
    const notDraft = stateRefusal(open.revision, open.state as RevisionState, 'draft');
    if (notDraft) {
      out = { ok: false, code: notDraft.code, detail: notDraft.detail };
      return null;
    }
    const [row] = await tx
      .select({ tldr: requirementRevisions.tldr, spec: requirementRevisions.spec })
      .from(requirementRevisions)
      .where(revisionWhere(requirementId, open.revision));
    if (!row) throw new Error(`requirements: ${requirementId} has no revision ${open.revision}`);
    const live = await tx
      .select({ id: requirementCriteria.id })
      .from(requirementCriteria)
      .where(
        and(
          eq(requirementCriteria.requirementId, requirementId),
          isNull(requirementCriteria.retiredRevision),
        ),
      );
    const draft = { tldr: row.tldr, spec: (row.spec ?? {}) as RequirementSpec };
    const filled = withGapsFilled(draft, draftGapsOf(draft, live.length), input.fills);
    if (filled.fields.length === 0) {
      out = { ok: true, revision: open.revision, fields: [] };
      return null;
    }
    await tx
      .update(requirementRevisions)
      .set({
        spec: storedDeep(level, filled.spec),
        tldr: filled.tldr === null ? null : storedText(level, filled.tldr).text,
      })
      .where(revisionWhere(requirementId, open.revision));
    if (filled.criteria.length) {
      const refused = await writeCriteria(
        tx,
        requirementId,
        open.revision,
        filled.criteria.map((body) => ({ body: storedText(level, body).text })),
      );
      if (refused) return refused;
    }
    out = { ok: true, revision: open.revision, fields: filled.fields };
    return null;
  });
  if (refusals?.length) {
    const [first] = refusals;
    return {
      ok: false,
      code: (first?.code ?? 'REQUIREMENT_REFUSED') as RequirementRefusalCode,
      detail: first?.detail ?? '',
    };
  }
  return out;
}
