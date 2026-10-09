/**
 * A merge-or-drop answer acts by itself (REQ-41 BC-12; Requirement lifecycle `draft`, Issue lifecycle
 * `draft`): on `question.answered` for a question the stale-draft sweep asked (`stale-drafts.ts`),
 * core carries out what the person chose. Drop drops the draft, its reason naming the question. Keep
 * changes nothing: the sweep asks again after another spell. Merge moves the draft's content into
 * the target its option names, as a proposed revision of a target requirement or a comment on a
 * target issue, and drops the draft naming the target, in one transaction. Where a rule says the act
 * cannot be done safely, nothing is written but the refusal, by name, on the answered round; the
 * draft's standing then waits on the master, never on nobody.
 */

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import type { RequirementSpec } from '@forge/contracts/requirements';
import { requirementKey } from '@forge/contracts/requirements';
import {
  isStaleDraftQuestion,
  STALE_DRAFT_OPTION_IDS,
  type StaleDraftActRefusal,
  type StaleDraftAnswer,
  type StaleDraftRefused,
} from '@forge/contracts/stale-drafts';
import { and, eq, sql } from 'drizzle-orm';
import { insertComment } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { issues } from '../db/schema.js';
import { agentQuestions, isChoiceStep, type QuestionOption } from '../db/schema-questions.js';
import { requirementCriteria, requirementRevisions } from '../db/schema-requirements.js';
import {
  accountActor,
  issueDisplayIds,
  draftMergeHolds as issueDraftMergeHolds,
  transitionIssueStatus,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { consume } from '../outbox/index.js';
import { recordAnswerResume } from '../questions/index.js';
import { dropIn } from './acceptance.js';
import { type RequirementActor, type Row, rowIn, signerRefusal } from './read.js';
import {
  newRevisionIn,
  openRevisionOf,
  type RevisionWrite,
  withdrawRevisionIn,
} from './revision-write.js';
import { type CriterionInput, liveAt } from './rules.js';
import { lockRequirements } from './write-tx.js';

const ANSWER_OF = new Map<string, StaleDraftAnswer>(
  (Object.entries(STALE_DRAFT_OPTION_IDS) as [StaleDraftAnswer, string][]).map(([a, id]) => [
    id,
    a,
  ]),
);

/** A merge-or-drop question as answered, read back from its row. */
export interface StaleDraftAnswered {
  questionId: string;
  projectId: string;
  issueId: string | null;
  requirementId: string | null;
  answer: StaleDraftAnswer;
  target: QuestionOption['target'] | null;
  answeredBy: string;
}

/** The answered merge-or-drop question, or null for any other question, or one already acted on. */
async function answeredOf(questionId: string): Promise<StaleDraftAnswered | null> {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  const step = row?.steps.at(-1);
  if (row?.status !== 'answered' || !step || !isChoiceStep(step)) return null;
  if (!isStaleDraftQuestion(step.options) || step.resume) return null;
  const answer = step.chosenOptionId ? ANSWER_OF.get(step.chosenOptionId) : undefined;
  if (!answer || !step.answeredBy) return null;
  const option = step.options.find((o) => o.id === step.chosenOptionId);
  return {
    questionId,
    projectId: row.projectId,
    issueId: row.issueId,
    requirementId: row.requirementId,
    answer,
    target: option?.target ?? null,
    answeredBy: step.answeredBy,
  };
}

const refused = (code: string, detail: string): StaleDraftRefused => ({ code, detail });
const ruled = (code: StaleDraftActRefusal, detail: string) => refused(code, detail);

/** The first refusal a service gave, as the answered round records it. */
const firstOf = (refusals: readonly { code: string; detail: string }[]) => {
  const [first] = refusals;
  return first ? refused(first.code, first.detail) : null;
};

const said = (a: StaleDraftAnswered) =>
  `the answer to Forge's merge-or-drop question ${a.questionId}`;

// ── requirements ────────────────────────────────────────────────────────────────────────────────

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

const ENDED_REQUIREMENT = ['dropped', 'deferred'];

/** The merge of a draft requirement into its target, then the drop of the draft, in `tx`. */
async function mergeRequirementIn(
  tx: Tx,
  a: StaleDraftAnswered,
  draft: Row,
  target: NonNullable<StaleDraftAnswered['target']>,
  actor: RequirementActor,
): Promise<StaleDraftRefused | null> {
  const draftKey = requirementKey(draft.reqSeq);
  if (target.kind !== 'requirement') {
    return ruled(
      'STALE_DRAFT_MERGE_NO_TARGET',
      `${draftKey} is a requirement and the merge names ${target.key}, an issue; a requirement merges only into a requirement.`,
    );
  }
  const into = await rowIn(tx, a.projectId, target.id).catch(() => null);
  if (!into || ENDED_REQUIREMENT.includes(into.status) || into.id === draft.id) {
    return ruled(
      'STALE_DRAFT_MERGE_TARGET_ENDED',
      `${target.key} is ${into ? into.status : 'no longer a requirement of this project'}, so there is no live requirement to move ${draftKey} into.`,
    );
  }
  const draftRevision = Math.max(draft.currentRevision ?? 0, await latestRevision(tx, draft.id));
  const from = await revisionContent(tx, draft.id, draftRevision);
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
    `Merged from ${draftKey} "${draft.title}" on ${said(a)}.`,
  );
  let moved = `nothing in it that ${target.key} does not already say`;
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
    moved = `its content is the proposed revision r${await latestRevision(tx, into.id)} of ${target.key}`;
  }
  const dropped = await dropIn(
    tx,
    a.projectId,
    draft.id,
    `Merged into ${target.key} on ${said(a)}: ${moved}.`,
    actor,
  );
  return dropped?.length ? firstOf(dropped) : null;
}

async function latestRevision(tx: Tx, requirementId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${requirementRevisions.revision}), 0)::int` })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId));
  return Number(row?.n ?? 0);
}

/**
 * Drop or merge a stale draft requirement. A stale draft revision of a requirement past draft is
 * withdrawn on a drop (the requirement keeps what was agreed), and refused on a merge.
 */
async function actOnRequirement(
  a: StaleDraftAnswered,
  requirementId: string,
): Promise<StaleDraftRefused | null> {
  const draft = await rowIn(db, a.projectId, requirementId);
  if (draft.status === 'dropped') return null;
  const key = requirementKey(draft.reqSeq);
  if (draft.status !== 'draft') {
    if (a.answer === 'drop') return withdrawStaleRevision(a, draft);
    return ruled(
      'STALE_DRAFT_MERGE_REVISION',
      `${key} is ${draft.status}: the stale draft is a revision of it, and merging it elsewhere would drop what was agreed.`,
    );
  }
  const actor = await requirementActor(a.answeredBy);
  const signer = await signerRefusal(actor, a.projectId, 'dropping a requirement', draft);
  if (signer) return firstOf([signer]);
  const target = a.target;
  if (a.answer === 'merge' && !target) {
    return ruled(
      'STALE_DRAFT_MERGE_NO_TARGET',
      `the merge option names no item to merge ${key} into.`,
    );
  }
  try {
    await db.transaction(async (tx) => {
      await lockRequirements(tx, a.projectId);
      const outcome =
        a.answer === 'merge' && target
          ? await mergeRequirementIn(tx, a, draft, target, actor)
          : firstOf(
              (await dropIn(tx, a.projectId, draft.id, `Dropped on ${said(a)}.`, actor)) ?? [],
            );
      // a refusal rolls back whatever the act wrote before it: only the refusal is recorded
      if (outcome) throw new RefusalError([{ ...outcome, path: '' }], outcome.code);
    });
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return firstOf(err.refusals) ?? refused(err.fallbackCode, err.message);
  }
}

/** Withdraw the open draft revision a drop names; none open means it was already acted on. */
async function withdrawStaleRevision(
  a: StaleDraftAnswered,
  draft: Row,
): Promise<StaleDraftRefused | null> {
  const actor = await requirementActor(a.answeredBy);
  try {
    await db.transaction(async (tx) => {
      await lockRequirements(tx, a.projectId);
      const open = await openRevisionOf(tx, draft.id);
      if (!open) return;
      const refusals = await withdrawRevisionIn(tx, {
        requirementId: draft.id,
        revision: open.revision,
        reason: `Withdrawn on ${said(a)}.`,
        actor,
      });
      const outcome = firstOf(refusals ?? []);
      if (outcome) throw new RefusalError([{ ...outcome, path: '' }], outcome.code);
    });
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return firstOf(err.refusals) ?? refused(err.fallbackCode, err.message);
  }
}

async function requirementActor(userId: string): Promise<RequirementActor> {
  const actor = await accountActor(userId);
  return {
    userId,
    agency: actor.type === 'user' && actor.agency === 'agent' ? 'agent' : 'human',
  };
}

// ── issues ──────────────────────────────────────────────────────────────────────────────────────

/** Drop or merge a stale draft issue through the issue machine; a refused move is recorded. */
async function actOnIssue(
  a: StaleDraftAnswered,
  issueId: string,
): Promise<StaleDraftRefused | null> {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      title: issues.title,
      description: issues.description,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue || issue.status === 'dropped') return null;
  const keys = await issueDisplayIds([issue.id, ...(a.target ? [a.target.id] : [])]);
  const key = keys.get(issue.id) ?? issue.id;
  if (issue.status !== 'draft') {
    return ruled(
      'STALE_DRAFT_MERGE_REVISION',
      `${key} is ${issue.status} now, no longer the draft the question asked about.`,
    );
  }
  let beforeStatusWrite: ((tx: Tx) => Promise<void>) | undefined;
  let reason = `Dropped on ${said(a)}.`;
  if (a.answer === 'merge') {
    const plan = await issueMergePlan(a, issue, key);
    if ('refused' in plan) return plan.refused;
    reason = `Merged into ${plan.targetKey} on ${said(a)}: its content is a comment there.`;
    beforeStatusWrite = async (tx) => {
      await insertComment(
        {
          issueId: plan.targetId,
          authorId: a.answeredBy,
          authorDeviceId: null,
          parentId: null,
          intent: 'note',
          writtenLang: null,
          body: plan.body,
        },
        tx,
      );
    };
  }
  try {
    await transitionIssueStatus(issue, 'dropped', await accountActor(a.answeredBy), {
      reason,
      transitionReason: reason,
      ...(beforeStatusWrite ? { beforeStatusWrite } : {}),
    });
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const lead = err.refusals[0];
    return refused(lead?.code ?? err.fallbackCode, lead?.detail ?? err.message);
  }
}

/** Where a draft issue's merge goes and what it carries, or why it cannot be done by rule. */
async function issueMergePlan(
  a: StaleDraftAnswered,
  issue: { id: string; projectId: string; title: string; description: string | null },
  key: string,
): Promise<{ targetId: string; targetKey: string; body: string } | { refused: StaleDraftRefused }> {
  const target = a.target;
  if (target?.kind !== 'issue') {
    return {
      refused: ruled(
        'STALE_DRAFT_MERGE_NO_TARGET',
        `the merge option names no issue to merge ${key} into.`,
      ),
    };
  }
  const [into] = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, target.id), eq(issues.projectId, issue.projectId)))
    .limit(1);
  if (!into || ISSUE_TERMINAL_STATUSES.includes(into.status as IssueStatus)) {
    return {
      refused: ruled(
        'STALE_DRAFT_MERGE_TARGET_ENDED',
        `${target.key} is ${into ? into.status : 'no longer an issue of this project'}, so there is no live issue to move ${key} into.`,
      ),
    };
  }
  const holds = [...(await issueDraftMergeHolds(issue.id)), ...(await feedbackRoutedTo(issue.id))];
  if (holds.length > 0) {
    return {
      refused: ruled(
        'STALE_DRAFT_MERGE_HAS_DEPENDENTS',
        `${key} is linked from ${holds.join(', ')}; a merge moves its text, not those links, so dropping it would leave them pointing at a dropped issue.`,
      ),
    };
  }
  const description = issue.description?.trim();
  const body = [
    `Merged from ${key} "${issue.title}" on ${said(a)}; ${key} is dropped.`,
    ...(description ? ['', description] : []),
  ].join('\n');
  return { targetId: into.id, targetKey: target.key, body };
}

/** The feedback items routed to an issue, by key. */
async function feedbackRoutedTo(issueId: string): Promise<string[]> {
  const rows = rowsOf<{ fb_seq: number }>(
    await db.execute(sql`
      SELECT f.fb_seq FROM feedback f
       WHERE f.issue_id = ${issueId}
          OR f.id IN (SELECT c.feedback_id FROM feedback_route_issues c WHERE c.issue_id = ${issueId})
       ORDER BY f.fb_seq`),
  );
  return rows.map((r) => `FB-${r.fb_seq}`);
}

// ── the consumer ────────────────────────────────────────────────────────────────────────────────

/**
 * Carry out one answered merge-or-drop question. Keep does nothing; drop and merge act, and a
 * refusal is recorded on the answered round, which the draft's standing reads as the master's turn.
 */
export async function actOnStaleDraftAnswer(
  questionId: string,
): Promise<{ acted: StaleDraftAnswer | null; refused: StaleDraftRefused | null }> {
  const a = await answeredOf(questionId);
  if (!a) return { acted: null, refused: null };
  if (a.answer === 'keep') return { acted: 'keep', refused: null };
  const outcome = a.requirementId
    ? await actOnRequirement(a, a.requirementId)
    : a.issueId
      ? await actOnIssue(a, a.issueId)
      : ruled('STALE_DRAFT_MERGE_NO_TARGET', 'the question stands on no requirement or issue.');
  if (outcome) {
    await recordAnswerResume(questionId, {
      kind: 'refused',
      ...outcome,
      at: new Date().toISOString(),
    });
    logger.warn(
      { questionId, projectId: a.projectId, answer: a.answer, code: outcome.code },
      'stale-draft-act: the answer was not carried out by rule; the draft waits on the master',
    );
    return { acted: null, refused: outcome };
  }
  logger.info(
    { questionId, projectId: a.projectId, answer: a.answer },
    'stale-draft-act: carried out',
  );
  return { acted: a.answer, refused: null };
}

/** Register the consumer. Called once at boot from `outbox-consumers.ts`. */
export function registerStaleDraftAct(): void {
  consume('question.answered', {
    name: 'stale-draft-act',
    handle: async (p) => {
      await actOnStaleDraftAnswer(p.questionId);
    },
  });
}
