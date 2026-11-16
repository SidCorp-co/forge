// Every other agent's audit of its own output (ISS-1251 c4): a master, a run and the steward score
// what they shipped against their role's rubric and the red flags of the cards they used, and name
// what they missed, in support.audit's shape. Each door is read against the catalog Forge serves, as
// a room agent's misses are (`audit.ts:missesOf`), and the verdict is kept in the one verdict store, so
// the capabilities page counts every kind's misses by the read it already makes. A failed verdict
// whose output names an item becomes a correction in the lessons store, as a failed room audit does.
// Nothing here audits on an agent's behalf: the act is a tool its card teaches.

import type { CorrectionItemKind } from '@forge/contracts/lessons';
import {
  RED_FLAG_LINE_PREFIX,
  type ReplyMiss,
  rubricFaults,
  type SelfAuditFailed,
  type SelfAuditRequest,
  type SelfAuditRole,
  type SelfAuditView,
} from '@forge/contracts/support-reply-audit';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  supportReplyVerdicts,
  type VERDICT_OUTPUT_KINDS,
} from '../../db/schema-support-verdicts.js';
import { findIssueById, issueDisplayIds, issueIdOfKey } from '../../issues/index.js';
import { recordCorrection } from '../../lessons/index.js';
import { doorCatalog } from '../../lib/door-catalog.js';
import { no, type Outcome } from '../outcome.js';
import { doorNamed, doorUnknown, missesOf } from './audit.js';

const REASON_CHARS = 900;

/** One failed line as kept: a rubric line by its key, a tripped red flag as `red_flag:<door>`. */
interface FailedLine {
  line: string;
  why: string;
}

/** What an audit says, read against the catalog: its failed lines and its misses, each by door id. */
export interface JudgedSelfAudit {
  failed: FailedLine[];
  missed: ReplyMiss[];
}

/**
 * The failed lines and misses an audit names: each line one of the role's rubric, each door read
 * against the catalog, a red flag naming a door whose card carries one and a miss a door Forge serves.
 * Anything else is refused by name, at its path, and nothing is kept.
 */
export function judgeSelfAudit(
  role: SelfAuditRole,
  failed: SelfAuditFailed | undefined,
  missed: SelfAuditRequest['missed'],
  catalog = doorCatalog(),
): Outcome<JudgedSelfAudit> {
  const [fault] = rubricFaults(role, failed);
  if (fault) return no('SELF_AUDIT_LINE_UNKNOWN', `/${fault.path.join('/')}`, fault.message);
  const lines: FailedLine[] = [];
  for (const [i, f] of (failed ?? []).entries()) {
    if (f.line !== undefined) {
      if (!lines.some((l) => l.line === f.line)) lines.push({ line: f.line, why: f.why });
      continue;
    }
    const ref = f.redFlag ?? '';
    const door = doorNamed(ref, catalog);
    if (!door) return doorUnknown('SELF_AUDIT_DOOR_UNKNOWN', `/failed/${i}/redFlag`, ref);
    if (!door.card?.redFlag) {
      return no(
        'SELF_AUDIT_NO_RED_FLAG',
        `/failed/${i}/redFlag`,
        `${door.id}'s card names no red flag to trip: name the rubric line the output fails instead, or forge_describe { action: "${door.id}" } to read its card. Nothing was kept.`,
      );
    }
    const line = `${RED_FLAG_LINE_PREFIX}${door.id}`;
    if (!lines.some((l) => l.line === line)) lines.push({ line, why: f.why });
  }
  const misses = missesOf(missed, catalog, 'SELF_AUDIT_DOOR_UNKNOWN');
  if (!misses.ok) return misses;
  return { ok: true, value: { failed: lines, missed: misses.value } };
}

/** The item a failed audit's correction is about, where its output names one. */
export interface AuditedItem {
  kind: CorrectionItemKind;
  id: string;
  key: string;
  title: string | null;
}

export interface KeepSelfAudit {
  projectId: string;
  agent: SelfAuditRole;
  output: { kind: (typeof VERDICT_OUTPUT_KINDS)[number]; ref: string };
  byUserId: string | null;
  agency: 'human' | 'agent';
  judged: JudgedSelfAudit;
  item: AuditedItem | null;
}

async function keptVerdict(
  input: Pick<KeepSelfAudit, 'projectId' | 'agent' | 'output'>,
): Promise<SelfAuditView | null> {
  const v = supportReplyVerdicts;
  const [row] = await db
    .select()
    .from(v)
    .where(
      and(
        eq(v.projectId, input.projectId),
        eq(v.agent, input.agent),
        eq(v.outputKind, input.output.kind),
        eq(v.outputRef, input.output.ref),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    verdict: row.verdict,
    failed: row.failed,
    missed: row.missed as ReplyMiss[],
    correctionId: row.correctionId,
    already: true,
  };
}

const reasonOf = (agent: SelfAuditRole, failed: readonly FailedLine[]) =>
  `A ${agent}'s audit of its own output failed: ${failed.map((f) => `${f.line} (${f.why})`).join('; ')}`.slice(
    0,
    REASON_CHARS,
  );

/**
 * Keep one self-audit: the verdict, and for a failed one whose output names an item its correction, in
 * one write. An output audited before in this role answers that verdict unchanged.
 */
export async function keepSelfAudit(input: KeepSelfAudit): Promise<SelfAuditView> {
  const before = await keptVerdict(input);
  if (before) return before;
  const { failed, missed } = input.judged;
  const verdict = failed.length > 0 ? 'fail' : 'pass';
  const kept = await db.transaction(async (tx) => {
    const correctionId =
      verdict === 'fail' && input.item
        ? await recordCorrection(tx, {
            projectId: input.projectId,
            source: 'self_audit',
            sourceRef: `${input.agent}:${input.output.kind}:${input.output.ref}`,
            item: input.item,
            reason: reasonOf(input.agent, failed),
            by: { userId: input.byUserId, agency: input.agency },
          })
        : null;
    const [row] = await tx
      .insert(supportReplyVerdicts)
      .values({
        projectId: input.projectId,
        agent: input.agent,
        outputKind: input.output.kind,
        outputRef: input.output.ref,
        byUserId: input.byUserId,
        verdict,
        failed: failed.map((f) => f.line),
        findings: failed.map((f) => ({ line: f.line, why: f.why, by: 'agent' })),
        missed,
        correctionId,
      })
      .onConflictDoNothing()
      .returning({ id: supportReplyVerdicts.id });
    return row ? correctionId : undefined;
  });
  // a second audit of the same output raced this one and was kept first: answer that one
  if (kept === undefined) {
    const raced = await keptVerdict(input);
    if (raced) return raced;
  }
  return {
    verdict,
    failed: failed.map((f) => f.line),
    missed,
    correctionId: kept ?? null,
    already: false,
  };
}

/** The issue an audit names in its project, by its key or its uuid; null where it names none there. */
async function issueOfOutput(projectId: string, ref: string): Promise<AuditedItem | null> {
  const id = await issueIdOfKey(ref, projectId);
  const issue = id ? await findIssueById(id) : null;
  if (!issue || issue.projectId !== projectId) return null;
  const key = (await issueDisplayIds([issue.id])).get(issue.id) ?? issue.id;
  return { kind: 'issue', id: issue.id, key, title: issue.title };
}

/**
 * A master's or run's audit of its own output (`audit.self`, `POST /api/projects/:id/self-audits`):
 * its doors read against the catalog, its output named in the project, then kept. A refusal keeps
 * nothing.
 */
export async function auditOwnWork(
  projectId: string,
  by: { userId: string | null; agency: 'human' | 'agent' },
  input: SelfAuditRequest,
): Promise<Outcome<SelfAuditView>> {
  const judged = judgeSelfAudit(input.as, input.failed, input.missed);
  if (!judged.ok) return judged;
  const item = await issueOfOutput(projectId, input.output.ref);
  if (!item) {
    return no(
      'SELF_AUDIT_OUTPUT_UNKNOWN',
      '/output/ref',
      `${input.output.ref} names no issue in this project: audit the issue you worked by its key (ISS-n) or uuid. Nothing was kept.`,
    );
  }
  return {
    ok: true,
    value: await keepSelfAudit({
      projectId,
      agent: input.as,
      output: { kind: 'issue', ref: item.id },
      byUserId: by.userId,
      agency: by.agency,
      judged: judged.value,
      item,
    }),
  };
}
