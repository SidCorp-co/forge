/**
 * The rules of an issue's timed checks (REQ-36 BC-14; Issue to release r20 `act-build`; ISS-474),
 * pure: which sent checks are new, which are a resend of a check already recorded as it is, and
 * which reuse a recorded check's id for another check; and the view the issue page reads.
 * `check-runs.ts` reads and writes around them.
 */

import {
  type CheckKind,
  type CheckRun,
  type CheckRunRefusalCode,
  type CheckRunResult,
  type CheckRunVia,
  checkTimeByKind,
  type IssueCheckRunView,
  type IssueChecksView,
} from '@forge/contracts/check-runs';

export interface CheckRunRefusal {
  code: CheckRunRefusalCode;
  path: string;
  detail: string;
}

/** A check as its row holds it. */
export interface StoredCheckRun {
  id: string;
  issueId: string;
  kind: CheckKind;
  name: string;
  scope: string;
  command: string;
  files: string[];
  result: CheckRunResult;
  durationMs: number;
  startedAt: Date;
  headSha: string;
  note: string | null;
  runSessionId: string | null;
  via: CheckRunVia;
  createdAt: Date;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Whether `row` is `sent` as it was recorded: the same check sent again, on the same issue and head. */
function sameCheck(row: StoredCheckRun, sent: CheckRun, issueId: string, head: string): boolean {
  return (
    row.issueId === issueId &&
    row.headSha === head &&
    row.kind === sent.kind &&
    row.name === sent.name &&
    row.scope === sent.scope &&
    row.command === sent.command &&
    row.result === sent.result &&
    row.durationMs === sent.durationMs &&
    row.startedAt.getTime() === new Date(sent.startedAt).getTime() &&
    (row.note ?? null) === (sent.note ?? null) &&
    row.files.length === sent.files.length &&
    row.files.every((f, i) => f === sent.files[i])
  );
}

/**
 * The sent checks split into those to write and the count already recorded as they are, or a
 * refusal per sent id a recorded check of different content holds. `issueKeys` names each stored
 * row's issue by its key, for the refusal.
 */
export function sortSentChecks(args: {
  issueId: string;
  head: string;
  checks: readonly CheckRun[];
  stored: readonly StoredCheckRun[];
  issueKeys: ReadonlyMap<string, string>;
}): { ok: true; fresh: CheckRun[]; again: number } | { ok: false; refusals: CheckRunRefusal[] } {
  const byId = new Map(args.stored.map((r) => [r.id, r]));
  const fresh: CheckRun[] = [];
  const refusals: CheckRunRefusal[] = [];
  let again = 0;
  args.checks.forEach((sent, i) => {
    const row = byId.get(sent.id);
    if (!row) {
      fresh.push(sent);
      return;
    }
    if (sameCheck(row, sent, args.issueId, args.head)) {
      again += 1;
      return;
    }
    const where = args.issueKeys.get(row.issueId) ?? 'another issue';
    refusals.push({
      code: 'CHECK_RUN_CONFLICT',
      path: `/checks/${i}/id`,
      detail: `check ${sent.id} is already recorded on ${where} as \`${row.name}\` (${row.kind}, ${row.scope || 'workspace'}) at ${row.headSha.slice(0, 12)}, ${row.result} in ${seconds(row.durationMs)} from ${row.startedAt.toISOString()}. One check is recorded once: a different check takes a new id, and a resend sends it exactly as it was. Nothing was recorded`,
    });
  });
  return refusals.length ? { ok: false, refusals } : { ok: true, fresh, again };
}

export function checkRunViewOf(row: StoredCheckRun): IssueCheckRunView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    command: row.command,
    files: row.files,
    result: row.result,
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    head: row.headSha,
    note: row.note,
    runSessionId: row.runSessionId,
    via: row.via,
    recordedAt: row.createdAt.toISOString(),
  };
}

/** The issue's checks, newest first, and the time spent on each kind. */
export function issueChecksViewOf(
  issueId: string,
  rows: readonly StoredCheckRun[],
): IssueChecksView {
  const checks = rows
    .map(checkRunViewOf)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  return {
    issueId,
    totalMs: checks.reduce((sum, c) => sum + c.durationMs, 0),
    kinds: checkTimeByKind(checks),
    checks,
  };
}
