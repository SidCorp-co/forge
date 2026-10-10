/**
 * The checks a run makes, recorded on its issue with their kind and duration (REQ-36 BC-14; Issue to
 * release r20 `act-build` "records each check's duration on the issue", `rule-merge` "checks run with
 * their durations, recorded on the issue"; ISS-474).
 *
 * A check is timed by the script that ran it — core cannot rerun one, and the runner never sees which
 * commands a session runs — so the record is the box's word for how long it took. Core decides which
 * run it came from: the run session holding the issue on the box that sent it, or the one the call's
 * `run` names (`pattern-runs.ts:runOfCall`), never a session the box claims. One check is one row,
 * keyed by the id its script gave it: `POST /api/issues/:id/checks` and the merge check's record
 * (`merge-check.ts`) both write through `writeCheckRuns`, and a resend adds nothing.
 */

import type {
  CheckRun,
  CheckRunVia,
  IssueChecksView,
  RecordChecksResponse,
} from '@forge/contracts/check-runs';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issueCheckRuns } from '../db/schema-issue-check-runs.js';
import { lockXact } from '../lib/advisory-lock.js';
import { emitEvent } from '../outbox/index.js';
import type { Actor } from './activity.js';
import {
  type CheckRunRefusal,
  issueChecksViewOf,
  type StoredCheckRun,
  sortSentChecks,
} from './check-run-rules.js';
import { issueDisplayIds } from './display-ids.js';
import { runOfCall } from './pattern-runs.js';

type Written = { ok: true; recorded: number; alreadyRecorded: number };
type Refused = { ok: false; refusals: CheckRunRefusal[] };

function storedOf(row: typeof issueCheckRuns.$inferSelect): StoredCheckRun {
  return {
    id: row.id,
    issueId: row.issueId,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    command: row.command,
    files: row.files,
    result: row.result,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
    headSha: row.headSha,
    note: row.note,
    runSessionId: row.runSessionId,
    via: row.via,
    createdAt: row.createdAt,
  };
}

/**
 * Write the checks one call sent, in the caller's transaction, under the issue's check lock: each new
 * one once, a resend of a recorded one as nothing, and a refusal — with nothing written — where a
 * sent id is recorded as another check.
 *
 * A write that added a check tells the issue's readers in the same transaction: `issue.updated`
 * naming `checks`, the frame an open issue page already refetches `['issue', id]` on. `checks`
 * is a record kept beside the issue row, not a column of it, so `before` and `after` carry
 * nothing and the activity feed writes no line for it — the Checks section is where it is read.
 */
export async function writeCheckRuns(
  tx: Tx,
  args: {
    issueId: string;
    projectId: string;
    head: string;
    checks: readonly CheckRun[];
    via: CheckRunVia;
    runSessionId: string | null;
    actor: Actor;
  },
): Promise<Written | Refused> {
  const head = args.head.toLowerCase();
  await lockXact(tx, 'issueCheckRuns', args.issueId);
  const ids = args.checks.map((c) => c.id.toLowerCase());
  const stored = (
    await tx.select().from(issueCheckRuns).where(inArray(issueCheckRuns.id, ids))
  ).map(storedOf);
  const others = [...new Set(stored.map((r) => r.issueId))];
  const sorted = sortSentChecks({
    issueId: args.issueId,
    head,
    checks: args.checks.map((c) => ({ ...c, id: c.id.toLowerCase() })),
    stored,
    issueKeys: others.length ? await issueDisplayIds(others, tx) : new Map(),
  });
  if (!sorted.ok) return sorted;
  if (sorted.fresh.length) {
    await tx.insert(issueCheckRuns).values(
      sorted.fresh.map((c) => ({
        id: c.id,
        issueId: args.issueId,
        kind: c.kind,
        name: c.name,
        scope: c.scope,
        command: c.command,
        files: c.files,
        result: c.result,
        durationMs: c.durationMs,
        startedAt: new Date(c.startedAt),
        headSha: head,
        note: c.note ?? null,
        runSessionId: args.runSessionId,
        via: args.via,
        recordedBy: args.actor.id,
        recordedAgency: args.actor.agency,
      })),
    );
    await emitEvent(tx, 'issue.updated', {
      issueId: args.issueId,
      projectId: args.projectId,
      actor: args.actor,
      fields: ['checks'],
      before: {},
      after: {},
    });
  }
  return { ok: true, recorded: sorted.fresh.length, alreadyRecorded: sorted.again };
}

/** The run session a call on this issue is made from, or a refusal where its `run` names none. */
export async function checkRunSessionOf(args: {
  issue: { id: string; projectId: string };
  box: string | null;
  run?: string | undefined;
}): Promise<{ ok: true; session: string | null } | Refused> {
  const run = await runOfCall({
    projectId: args.issue.projectId,
    issueId: args.issue.id,
    box: args.box,
    run: args.run,
  });
  if (run.ok) return { ok: true, session: run.value.session };
  return {
    ok: false,
    refusals: run.refusals.map((r) => ({
      code: 'CHECK_RUN_UNKNOWN',
      path: r.path,
      detail: r.detail,
    })),
  };
}

/** `POST /api/issues/:id/checks`: record the checks a run timed, on the run it came from. */
export async function recordChecks(args: {
  issue: { id: string; projectId: string };
  head: string;
  checks: readonly CheckRun[];
  run?: string | undefined;
  box: string | null;
  actor: Actor;
}): Promise<{ ok: true; value: RecordChecksResponse } | Refused> {
  const session = await checkRunSessionOf(args);
  if (!session.ok) return session;
  const written = await db.transaction((tx) =>
    writeCheckRuns(tx, {
      issueId: args.issue.id,
      projectId: args.issue.projectId,
      head: args.head,
      checks: args.checks,
      via: 'report',
      runSessionId: session.session,
      actor: args.actor,
    }),
  );
  if (!written.ok) return written;
  return {
    ok: true,
    value: {
      issueId: args.issue.id,
      recorded: written.recorded,
      alreadyRecorded: written.alreadyRecorded,
      runSessionId: session.session,
    },
  };
}

/** `GET /api/issues/:id/checks`: every check recorded on the issue and the time spent per kind. */
export async function issueChecksOf(issueId: string): Promise<IssueChecksView> {
  const rows = await db
    .select()
    .from(issueCheckRuns)
    .where(eq(issueCheckRuns.issueId, issueId))
    .orderBy(asc(issueCheckRuns.startedAt));
  return issueChecksViewOf(issueId, rows.map(storedOf));
}
