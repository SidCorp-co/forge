// cm:why ISS-113 (design automation rev 1, steps report, triage, file, dismiss, reports_table;
// REQ-16 BC-2..BC-4), on real Postgres. Migration 0368 is read off disk and run inside a rolled-back
// transaction over the schema as it stood before it: each reviewed state maps to its triage, a
// report from a schedule session is linked to its fire, and a row the mapping cannot represent
// stops the migration by name. The triage acts run through the one service both doors call.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION = readFileSync(
  resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/migrations/0368_an_agent_report_is_triaged.sql',
  ),
  'utf8',
);

type Service = typeof import('../../src/agent-reports/service.js');
type Promote = typeof import('../../src/feedback/promote.js');
type Schema = typeof import('../../src/db/schema.js');

let harness: TestDatabase;
let client: Sql;
let notices: string[] = [];
let userId: string;
let projectId: string;
let otherProjectId: string;
let service: Service;
let promote: Promote;
let schema: Schema;

class Rollback extends Error {}
type Tx = postgres.TransactionSql;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  client = postgres(harness.url, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
  const user = await createTestUser(harness.db);
  userId = user.id;
  projectId = (await createTestProject(harness.db, userId)).id;
  otherProjectId = (await createTestProject(harness.db, userId)).id;
  service = await import('../../src/agent-reports/service.js');
  promote = await import('../../src/feedback/promote.js');
  schema = await import('../../src/db/schema.js');
}, 120_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  if (harness) await harness.cleanup();
});

async function runIn(tx: Tx | Sql): Promise<string> {
  const [run] = await tx`
    INSERT INTO pipeline_runs (project_id, kind, status, metadata)
    VALUES (${projectId}, 'system', 'running', '{"source":"schedule.run"}'::jsonb) RETURNING id`;
  return run?.id as string;
}

async function asBeforeTheMigration(tx: Tx): Promise<void> {
  await tx.unsafe(`
    ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_triage_chk;
    ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_triaged_by_chk;
    DROP INDEX agent_reports_project_triage_idx;
    DROP INDEX agent_reports_schedule_run_idx;
    ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_linked_issue_id_issues_id_fk;
    ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_linked_issue_id_issues_id_fk
      FOREIGN KEY (linked_issue_id) REFERENCES issues(id) ON DELETE SET NULL;
    ALTER TABLE agent_reports DROP COLUMN schedule_run_id, DROP COLUMN triage, DROP COLUMN triaged_by,
      DROP COLUMN triaged_agency, DROP COLUMN triaged_at, DROP COLUMN triage_reason, DROP COLUMN duplicate_of;
    ALTER TABLE agent_reports ADD COLUMN reviewed_at timestamptz;
    ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_promoted_reviewed_chk
      CHECK (feedback_id IS NULL OR reviewed_at IS NOT NULL);
  `);
}

async function migrate(tx: Tx): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(MIGRATION);
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  notices = [];
  try {
    await client.begin(async (tx) => {
      await asBeforeTheMigration(tx);
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function issueIn(tx: Tx | Sql, project = projectId): Promise<string> {
  const [row] = await tx`
    INSERT INTO issues (project_id, title, status, created_by_id)
    VALUES (${project}, 'carrier', 'draft', ${userId}) RETURNING id`;
  return row?.id as string;
}

async function oldReport(
  tx: Tx,
  args: {
    reviewed?: boolean;
    linkedIssueId?: string;
    feedbackId?: string;
    sessionId?: string;
  },
): Promise<string> {
  const [row] = await tx`
    INSERT INTO agent_reports (project_id, kind, target, summary, signal_key, reviewed_at,
                               linked_issue_id, feedback_id, session_id)
    VALUES (${projectId}, 'friction', 'skill', 'old report', 'self_report:skill:-:friction',
            ${args.reviewed ? new Date('2026-09-01T00:00:00.000Z') : null},
            ${args.linkedIssueId ?? null}, ${args.feedbackId ?? null}, ${args.sessionId ?? null})
    RETURNING id`;
  return row?.id as string;
}

async function scheduleSession(
  tx: Tx,
  fire: boolean,
): Promise<{ session: string; fire: string | null }> {
  const [s] = await tx`
    INSERT INTO schedules (project_id, name, cron, prompt, kind, owner_id)
    VALUES (${projectId}, 'nightly', '0 3 * * *', 'go', 'prompt', ${userId}) RETURNING id`;
  let fireId: string | null = null;
  if (fire) {
    const [f] = await tx`
      INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, started_at, finished_at)
      VALUES (${s?.id as string}, ${projectId}, 'scheduled', 'success', now(), now()) RETURNING id`;
    fireId = f?.id as string;
  }
  const metadata: Record<string, string> = { source: 'schedule.run', scheduleId: s?.id as string };
  if (fireId) metadata.scheduleRunId = fireId;
  const [a] = await tx`
    INSERT INTO agent_sessions (project_id, user_id, kind, status, metadata, pipeline_run_id)
    VALUES (${projectId}, ${userId}, 'chat', 'completed', ${tx.json(metadata)}, ${await runIn(tx)}) RETURNING id`;
  return { session: a?.id as string, fire: fireId };
}

describe('0368 maps every reviewed state to a triage', () => {
  it('unreviewed is new, reviewed with a link is filed, reviewed with none is dismissed by name', async () => {
    await inRollback(async (tx) => {
      const issue = await issueIn(tx);
      const [seq] =
        await tx`SELECT coalesce(max(fb_seq), 0) + 1 AS n FROM feedback WHERE project_id = ${projectId}`;
      const [fb] = await tx`
        INSERT INTO feedback (project_id, fb_seq, kind, title, where_seen, reported_by, reporter_agency)
        VALUES (${projectId}, ${seq?.n as number}, 'bug', 'promoted', 'Improvements', ${userId}, 'human')
        RETURNING id`;
      const fresh = await oldReport(tx, {});
      const intoIssue = await oldReport(tx, { reviewed: true, linkedIssueId: issue });
      const intoFeedback = await oldReport(tx, { reviewed: true, feedbackId: fb?.id as string });
      const unlinked = await oldReport(tx, { reviewed: true });

      expect(await migrate(tx)).toBeNull();

      const rows = await tx`
        SELECT id, triage, triaged_by, triaged_at, triage_reason, linked_issue_id, feedback_id
        FROM agent_reports WHERE id IN ${tx([fresh, intoIssue, intoFeedback, unlinked])}`;
      const by = new Map(rows.map((r) => [r.id as string, r]));
      expect(by.get(fresh)).toMatchObject({ triage: 'new', triaged_at: null, triage_reason: null });
      expect(by.get(intoIssue)).toMatchObject({
        triage: 'filed',
        linked_issue_id: issue,
        triaged_by: null,
      });
      expect(by.get(intoFeedback)).toMatchObject({ triage: 'filed', feedback_id: fb?.id });
      expect(by.get(unlinked)).toMatchObject({
        triage: 'dismissed',
        triage_reason: 'reviewed before triage was recorded',
        triaged_by: null,
      });
      expect(by.get(unlinked)?.triaged_at).toEqual(new Date('2026-09-01T00:00:00.000Z'));
      const [col] = await tx`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'agent_reports' AND column_name = 'reviewed_at'`;
      expect(col?.n).toBe(0);
    });
  });

  it('links a report to the fire its session ran for, and reports by name the ones it cannot', async () => {
    await inRollback(async (tx) => {
      const fired = await scheduleSession(tx, true);
      const orphan = await scheduleSession(tx, false);
      const linked = await oldReport(tx, { sessionId: fired.session });
      const lost = await oldReport(tx, { sessionId: orphan.session });
      const issueRun = await oldReport(tx, {});

      expect(await migrate(tx)).toBeNull();

      const rows =
        await tx`SELECT id, schedule_run_id FROM agent_reports WHERE id IN ${tx([linked, lost, issueRun])}`;
      const fireOf = new Map(rows.map((r) => [r.id as string, r.schedule_run_id as string | null]));
      expect(fireOf.get(linked)).toBe(fired.fire);
      expect(fireOf.get(lost)).toBeNull();
      expect(fireOf.get(issueRun)).toBeNull();
      const [marker] =
        await tx`SELECT report FROM backfill_markers WHERE key = '0368_agent_report_triage'`;
      const report = marker?.report as { runs: Record<string, unknown>[] } | undefined;
      const run = report?.runs.at(-1);
      expect(run).toMatchObject({ fireLinked: 1, fireUnlinked: 1, new: 3 });
      expect(run?.unlinked).toEqual([
        expect.objectContaining({ reportId: lost, sessionId: orphan.session }),
      ]);
      expect(
        notices.some((n) =>
          n.includes('1 report(s) came from a schedule session whose fire is not recorded'),
        ),
      ).toBe(true);
    });
  });

  it('stops by name on an unreviewed report that links an issue, and writes nothing', async () => {
    await inRollback(async (tx) => {
      const issue = await issueIn(tx);
      const stray = await oldReport(tx, { linkedIssueId: issue });
      const fine = await oldReport(tx, { reviewed: true });

      expect(await migrate(tx)).toBe(
        `AGENT_REPORT_TRIAGE_UNMAPPED: agent_reports row ${stray} is unreviewed but links issue ${issue} and feedback null; an unreviewed report becomes new, which has no target, and a filed one needs the time it was reviewed, so this migration writes nothing until that row is repaired`,
      );
      const [row] = await tx`SELECT reviewed_at FROM agent_reports WHERE id = ${fine}`;
      expect(row?.reviewed_at).not.toBeNull();
    });
  });
});

async function newReport(
  project = projectId,
  signalKey = 'self_report:skill:x:friction',
): Promise<string> {
  const [row] = await client`
    INSERT INTO agent_reports (project_id, kind, severity, target, target_ref, summary, detail, signal_key)
    VALUES (${project}, 'bug', 'high', 'skill', 'forge-test', 'The boundary axis is missed',
            'Seen twice', ${signalKey})
    RETURNING id`;
  return row?.id as string;
}

const actor = () => ({ userId, agency: 'human' as const });

async function act(id: string, triage: Parameters<Service['triageReports']>[0]['act']) {
  const { eq } = await import('drizzle-orm');
  return service.triageReports({
    scope: [eq(schema.agentReports.id, id)],
    bulk: false,
    act: triage,
    actor: actor(),
    channel: 'web',
    linkIssue: null,
  });
}

async function readRow(id: string) {
  const [row] = await client`SELECT * FROM agent_reports WHERE id = ${id}`;
  return row as Record<string, unknown>;
}

describe('triage acts (REQ-16 BC-3)', () => {
  it('filing creates the issue at draft with the report as evidence and sets filed in the same write', async () => {
    const id = await newReport();
    const out = await act(id, { act: 'file', createIssue: {} });
    if (!out.ok) throw new Error(JSON.stringify(out.refusals));
    const issueId = out.effect.issue?.id as string;
    const [issue] =
      await client`SELECT status, title, description, priority, category FROM issues WHERE id = ${issueId}`;
    expect(issue).toMatchObject({
      status: 'draft',
      title: 'The boundary axis is missed',
      priority: 'high',
      category: 'bug',
    });
    expect(issue?.description).toContain(`Agent report ${id}`);
    expect(await readRow(id)).toMatchObject({
      triage: 'filed',
      linked_issue_id: issueId,
      triaged_by: userId,
      triaged_agency: 'human',
    });
    const [event] = await client`
      SELECT action FROM activity_log WHERE issue_id = ${issueId} AND action = 'record.decision'`;
    expect(event).toBeDefined();
  });

  it('a second triage is refused naming who filed it and into which issue', async () => {
    const id = await newReport();
    const first = await act(id, { act: 'file', createIssue: {} });
    if (!first.ok) throw new Error('file refused');
    const out = await act(id, { act: 'dismiss', reason: 'not work' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]?.code).toBe('AGENT_REPORT_ALREADY_TRIAGED');
    expect(out.refusals[0]?.detail).toContain(`filed into ${first.effect.issue?.key}`);
  });

  it('dismiss needs a reason; duplicate needs a report of the same project; reopen needs a triage', async () => {
    const id = await newReport();
    const elsewhere = await newReport(otherProjectId);
    const codes = async (t: Parameters<typeof act>[1]) => {
      const out = await act(id, t);
      return out.ok ? [] : out.refusals.map((r) => r.code);
    };
    expect(await codes({ act: 'dismiss', reason: '  ' })).toEqual([
      'AGENT_REPORT_DISMISS_REASON_REQUIRED',
    ]);
    expect(await codes({ act: 'duplicate', duplicateOf: elsewhere })).toEqual([
      'AGENT_REPORT_DUPLICATE_UNKNOWN',
    ]);
    expect(await codes({ act: 'duplicate', duplicateOf: randomUUID() })).toEqual([
      'AGENT_REPORT_DUPLICATE_UNKNOWN',
    ]);
    expect(await codes({ act: 'reopen' })).toEqual(['AGENT_REPORT_NOT_TRIAGED']);
    expect((await readRow(id)).triage).toBe('new');
  });

  it('dismiss, duplicate and reopen each write their own columns, and reopen clears the outcome', async () => {
    const original = await newReport();
    const id = await newReport();
    expect(
      (await act(id, { act: 'duplicate', duplicateOf: original, reason: 'same defect' })).ok,
    ).toBe(true);
    expect(await readRow(id)).toMatchObject({
      triage: 'duplicate',
      duplicate_of: original,
      triage_reason: 'same defect',
    });
    expect((await act(id, { act: 'reopen' })).ok).toBe(true);
    expect(await readRow(id)).toMatchObject({
      triage: 'new',
      duplicate_of: null,
      triaged_by: null,
      triaged_at: null,
      triage_reason: null,
    });
    expect((await act(id, { act: 'dismiss', reason: 'already fixed' })).ok).toBe(true);
    expect(await readRow(id)).toMatchObject({
      triage: 'dismissed',
      triage_reason: 'already fixed',
    });
  });

  it('a bulk act by signal moves the new reports, each with its own triagedBy, and names the rest', async () => {
    const signal = `self_report:skill:${randomUUID()}:friction`;
    const a = await newReport(projectId, signal);
    const b = await newReport(projectId, signal);
    const done = await newReport(projectId, signal);
    expect((await act(done, { act: 'dismiss', reason: 'earlier' })).ok).toBe(true);
    const { and, eq } = await import('drizzle-orm');
    const out = await service.triageReports({
      scope: [
        and(
          eq(schema.agentReports.projectId, projectId),
          eq(schema.agentReports.signalKey, signal),
        ) as never,
      ],
      bulk: true,
      act: { act: 'file', createIssue: { title: 'One defect, three reports' } },
      actor: actor(),
      channel: 'mcp',
      linkIssue: null,
    });
    if (!out.ok) throw new Error(JSON.stringify(out.refusals));
    expect(new Set(out.effect.reports)).toEqual(new Set([a, b]));
    expect(out.effect.untouched).toEqual([{ id: done, triage: 'dismissed' }]);
    for (const id of [a, b]) {
      expect(await readRow(id)).toMatchObject({
        triage: 'filed',
        linked_issue_id: out.effect.issue?.id,
        triaged_by: userId,
      });
    }
  });

  it('the database refuses a filed report with no target and a new report that carries one', async () => {
    const id = await newReport();
    await expect(
      client`UPDATE agent_reports SET triage = 'filed', triaged_at = now() WHERE id = ${id}`,
    ).rejects.toThrow(/agent_reports_triage_chk/);
    const issue = await issueIn(client);
    await expect(
      client`UPDATE agent_reports SET linked_issue_id = ${issue} WHERE id = ${id}`,
    ).rejects.toThrow(/agent_reports_triage_chk/);
  });

  it('the issue a report was filed into is not deleted under it', async () => {
    const id = await newReport();
    const out = await act(id, { act: 'file', createIssue: {} });
    if (!out.ok) throw new Error('file refused');
    const [issue] =
      await client`SELECT id, project_id, iss_seq FROM issues WHERE id = ${out.effect.issue?.id as string}`;
    const refusal = await service.issueDeleteRefusal({
      id: issue?.id as string,
      projectId: issue?.project_id as string,
      issSeq: issue?.iss_seq as number,
    });
    expect(refusal?.code).toBe('AGENT_REPORT_FILED_INTO_ISSUE');
    expect(refusal?.detail).toContain(id);
    await expect(client`DELETE FROM issues WHERE id = ${issue?.id as string}`).rejects.toThrow(
      /agent_reports_linked_issue_id/,
    );
  });
});

describe('a triage across every project moves reports only where the caller may write', () => {
  it('leaves out a project the caller only views, and keeps one the org makes them admin of', async () => {
    const { createTestProjectMember } = await import('../helpers/index.js');
    const { listVisibleProjectsWithRole } = await import('../../src/projects/service.js');
    const owner = await createTestUser(harness.db);
    const viewed = (await createTestProject(harness.db, owner.id)).id;
    const viewer = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: viewer.id,
      projectId: viewed,
      role: 'viewer',
    });
    const own = (await createTestProject(harness.db, viewer.id)).id;
    const rows = await listVisibleProjectsWithRole(viewer.id);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([viewed, own]));
    expect(service.writableProjectIds(rows)).toEqual([own]);
  });
});

describe('promoting a report into feedback files it (ISS-93 on triage)', () => {
  it('sets filed with the feedback item as its one target, by the promoter, in the same write', async () => {
    const id = await newReport();
    const out = await promote.promoteAgentReport({
      projectId,
      actor: actor(),
      request: { agentReport: id, kind: 'bug', screen: 'Improvements' },
    });
    if (!out.ok) throw new Error(JSON.stringify(out.refusals));
    const row = await readRow(id);
    expect(row).toMatchObject({ triage: 'filed', triaged_by: userId, linked_issue_id: null });
    expect(row.feedback_id).not.toBeNull();
    const reopen = await act(id, { act: 'reopen' });
    expect(reopen.ok ? [] : reopen.refusals.map((r) => r.code)).toEqual(['AGENT_REPORT_PROMOTED']);
    const again = await promote.promoteAgentReport({
      projectId,
      actor: actor(),
      request: { agentReport: id, kind: 'bug', screen: 'Improvements' },
    });
    expect(again.ok ? [] : again.refusals.map((r) => r.code)).toEqual([
      'FEEDBACK_SOURCE_ALREADY_PROMOTED',
    ]);
  });

  it('a dismissed report is a second triage, refused until it is reopened', async () => {
    const id = await newReport();
    expect((await act(id, { act: 'dismiss', reason: 'noise' })).ok).toBe(true);
    const out = await promote.promoteAgentReport({
      projectId,
      actor: actor(),
      request: { agentReport: id, kind: 'bug', screen: 'Improvements' },
    });
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual(['AGENT_REPORT_ALREADY_TRIAGED']);
  });

  it('a report filed into an issue keeps the ISS-93 refusal naming that issue', async () => {
    const id = await newReport();
    expect((await act(id, { act: 'file', createIssue: {} })).ok).toBe(true);
    const out = await promote.promoteAgentReport({
      projectId,
      actor: actor(),
      request: { agentReport: id, kind: 'bug', screen: 'Improvements' },
    });
    expect(out.ok ? [] : out.refusals.map((r) => r.code)).toEqual([
      'FEEDBACK_SOURCE_ROUTED_ELSEWHERE',
    ]);
  });
});

describe('a report names the fire that filed it (REQ-16 BC-2)', () => {
  it('reads the fire off the session, and none for a session with no fire or no session', async () => {
    const [s] = await client`
      INSERT INTO schedules (project_id, name, cron, prompt, kind, owner_id)
      VALUES (${projectId}, 'fire link', '0 3 * * *', 'go', 'prompt', ${userId}) RETURNING id`;
    const [f] = await client`
      INSERT INTO schedule_runs (schedule_id, project_id, trigger, status, started_at)
      VALUES (${s?.id as string}, ${projectId}, 'manual', 'running', now()) RETURNING id`;
    const meta = (extra: Record<string, string>) =>
      client.json({ source: 'schedule.run', scheduleId: s?.id as string, ...extra });
    const [fired] = await client`
      INSERT INTO agent_sessions (project_id, user_id, kind, status, metadata, pipeline_run_id)
      VALUES (${projectId}, ${userId}, 'chat', 'running', ${meta({ scheduleRunId: f?.id as string })}, ${await runIn(client)}) RETURNING id`;
    const [gone] = await client`
      INSERT INTO agent_sessions (project_id, user_id, kind, status, metadata, pipeline_run_id)
      VALUES (${projectId}, ${userId}, 'chat', 'running', ${meta({ scheduleRunId: randomUUID() })}, ${await runIn(client)}) RETURNING id`;
    expect(await service.fireOfSession(fired?.id as string)).toBe(f?.id);
    expect(await service.fireOfSession(gone?.id as string)).toBeNull();
    expect(await service.fireOfSession(null)).toBeNull();
  });
});
