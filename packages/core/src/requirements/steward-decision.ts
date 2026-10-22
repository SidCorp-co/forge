/**
 * A steward decision on a draft requirement, carried out as the person who answered it, inside the
 * answer's transaction (REQ-48 BC-5; Requirement lifecycle `draft`, `rev_draft`). Drop drops a draft
 * requirement; withdraw withdraws the open draft revision of one already agreed, which keeps what was
 * agreed; merge writes what the draft says that the live requirement it repeats does not as a
 * proposed revision of that one, then drops the draft. Drop and merge take a signer, as the drop
 * door does; withdraw takes the draft's author or a signer. A rule the act breaks is a refusal by
 * name, so the answer is refused and the question stays open.
 */

import type { RequirementSpec } from '@forge/contracts/requirements';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirementCriteria, requirementRevisions } from '../db/schema-requirements.js';
import type { Refusal } from '../lib/refusal.js';
import { dropIn } from './acceptance.js';
import { type RequirementActor, type Row, requirementIdIn, rowIn, signerRefusal } from './read.js';
import { newRevisionIn, type RevisionWrite, withdrawRevisionIn } from './revision-write.js';
import { type CriterionInput, liveAt } from './rules.js';
import { lockRequirements } from './write-tx.js';

/** What the steward's decision on a draft requirement does. */
export type StewardRequirementAct =
  | { act: 'drop'; reason: string }
  | { act: 'withdraw'; reason: string }
  | { act: 'merge'; into: string; reason: string };

const ENDED = ['dropped', 'deferred'];

const refused = (code: string, detail: string, path = '/optionId'): Refusal => ({
  code,
  detail,
  path,
});

/** A revision's spec and the criteria live at it. */
async function revisionContent(tx: Tx, requirementId: string, revision: number) {
  const [rev] = await tx
    .select({ spec: requirementRevisions.spec })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, revision),
      ),
    );
  const all = await tx
    .select()
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, requirementId));
  return { spec: (rev?.spec ?? {}) as RequirementSpec, criteria: liveAt(all, revision) };
}

async function latestRevision(tx: Tx, requirementId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${requirementRevisions.revision}), 0)::int` })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId));
  return Number(row?.n ?? 0);
}

const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function unionOf(into: readonly string[] | undefined, from: readonly string[] | undefined) {
  const seen = new Set((into ?? []).map(norm));
  const added = (from ?? []).filter((t) => t.trim() && !seen.has(norm(t)));
  return { list: [...(into ?? []), ...added], added: added.length };
}

/**
 * The target's head with what the draft says that the head does not: its scope, personas and
 * assumptions not already there, and its criteria under new codes. Null when the draft adds nothing.
 */
export function mergedWrite(
  target: { spec: RequirementSpec; criteria: readonly CriterionInput[] },
  draft: { key: string; title: string; spec: RequirementSpec; criteria: readonly CriterionInput[] },
  reason: string,
): RevisionWrite | null {
  const scopeIn = unionOf(target.spec.scopeIn, draft.spec.scopeIn);
  const scopeOut = unionOf(target.spec.scopeOut, draft.spec.scopeOut);
  const personas = unionOf(target.spec.personas, draft.spec.personas);
  const knownAssumptions = new Set((target.spec.assumptions ?? []).map((a) => norm(a.text)));
  const assumptions = (draft.spec.assumptions ?? []).filter(
    (a) => !knownAssumptions.has(norm(a.text)),
  );
  const knownCriteria = new Set(target.criteria.map((c) => norm(c.body)));
  const criteria = draft.criteria
    .filter((c) => !knownCriteria.has(norm(c.body)))
    .map((c) => ({ body: c.body, ...(c.form ? { form: c.form } : {}) }));
  const lines = scopeIn.added + scopeOut.added + personas.added + assumptions.length;
  if (lines + criteria.length === 0) return null;
  return {
    reason,
    spec: {
      ...target.spec,
      scopeIn: scopeIn.list,
      scopeOut: scopeOut.list,
      personas: personas.list,
      assumptions: [...(target.spec.assumptions ?? []), ...assumptions],
    },
    criteria: [...target.criteria, ...criteria],
    changeSummary: `Merged from ${draft.key} "${draft.title}": ${criteria.length} criteria and ${lines} scope, persona or assumption lines it said that this did not.`,
  };
}

const firstOf = (refusals: readonly Refusal[] | null | undefined) => refusals?.[0] ?? null;

/** The merge of a draft requirement into the live one it repeats, then the drop of the draft. */
async function mergeIn(
  tx: Tx,
  projectId: string,
  draft: Row,
  intoKey: string,
  actor: RequirementActor,
  reason: string,
): Promise<Refusal | null> {
  const draftKey = requirementKey(draft.reqSeq);
  const intoId = await requirementIdIn(tx, projectId, intoKey);
  const into = intoId ? await rowIn(tx, projectId, intoId) : null;
  if (!into || ENDED.includes(into.status) || into.id === draft.id) {
    return refused(
      'STEWARD_MERGE_TARGET_ENDED',
      `${intoKey} is ${into ? (into.id === draft.id ? `${draftKey} itself` : into.status) : 'no requirement of this project'}, so there is no live requirement to merge ${draftKey} into; void the question and let the steward ask again`,
    );
  }
  const from = await revisionContent(
    tx,
    draft.id,
    Math.max(draft.currentRevision ?? 0, await latestRevision(tx, draft.id)),
  );
  const head = into.currentRevision;
  const onto =
    head === null ? { spec: {}, criteria: [] } : await revisionContent(tx, into.id, head);
  const write = mergedWrite(
    {
      spec: onto.spec,
      criteria: onto.criteria.map((c) => ({ code: c.code, body: c.body, form: c.form as never })),
    },
    {
      key: draftKey,
      title: draft.title,
      spec: from.spec,
      criteria: from.criteria.map((c) => ({ body: c.body, form: c.form as never })),
    },
    `Merged from ${draftKey} "${draft.title}" on ${reason}.`,
  );
  let moved = `nothing in it that ${intoKey} does not already say`;
  if (write) {
    const written = await newRevisionIn(tx, {
      requirementId: into.id,
      head,
      baseRevision: head,
      actor,
      write,
      landing: { state: 'proposed', proposedBy: actor.userId },
    });
    if (written?.length) return firstOf(written);
    moved = `its content is the proposed revision r${await latestRevision(tx, into.id)} of ${intoKey}`;
  }
  return firstOf(
    await dropIn(tx, projectId, draft.id, `Merged into ${intoKey} on ${reason}: ${moved}.`, actor),
  );
}

/**
 * Carry one decision out on requirement `requirementId` in `tx`, as `actor`; a refusal by name, or
 * null where it was done. `said` names the question the answer came from.
 */
export async function stewardRequirementActIn(
  tx: Tx,
  input: {
    projectId: string;
    requirementId: string;
    actor: RequirementActor;
    decision: StewardRequirementAct;
    said: string;
  },
): Promise<Refusal | null> {
  const { projectId, actor, decision, said } = input;
  await lockRequirements(tx, projectId);
  const row = await rowIn(tx, projectId, input.requirementId);
  const key = requirementKey(row.reqSeq);
  if (decision.act === 'withdraw') {
    const [open] = await tx
      .select({ revision: requirementRevisions.revision, authorId: requirementRevisions.authorId })
      .from(requirementRevisions)
      .where(
        and(
          eq(requirementRevisions.requirementId, row.id),
          eq(requirementRevisions.state, 'draft'),
        ),
      );
    if (!open) {
      return refused(
        'STEWARD_DECISION_STALE',
        `${key} holds no draft revision now, so there is nothing to withdraw; void the question`,
      );
    }
    if (open.authorId !== actor.userId) {
      const signer = await signerRefusal(actor, projectId, 'withdrawing a draft revision', row);
      if (signer) return signer;
    }
    return firstOf(
      await withdrawRevisionIn(tx, {
        requirementId: row.id,
        revision: open.revision,
        reason: `Withdrawn on ${said}: ${decision.reason}`,
        actor,
      }),
    );
  }
  if (row.status !== 'draft') {
    return refused(
      'STEWARD_DECISION_STALE',
      `${key} is ${row.status} now, no longer the draft this question asked about; answer keep, or void the question`,
    );
  }
  const signer = await signerRefusal(
    actor,
    projectId,
    decision.act === 'merge' ? 'merging a requirement' : 'dropping a requirement',
    row,
  );
  if (signer) return signer;
  if (decision.act === 'merge') {
    return mergeIn(tx, projectId, row, decision.into, actor, `${said}: ${decision.reason}`);
  }
  return firstOf(
    await dropIn(tx, projectId, row.id, `Dropped on ${said}: ${decision.reason}`, actor),
  );
}
