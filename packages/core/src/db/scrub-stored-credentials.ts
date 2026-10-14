import type postgres from 'postgres';
import {
  credentialsFrom,
  type StoredCredential,
  withholdCredentials,
} from '../comments/credential-guard.js';

type Sql = postgres.Sql<Record<string, never>>;

/** How many stored rows each surface had rewritten. */
export interface ScrubReport {
  activity: number;
  kernelTransitions: number;
  outbox: number;
  questions: number;
}

interface Rewrite {
  table: 'activity_log' | 'kernel_transitions' | 'pipeline_outbox' | 'agent_questions';
  id: string;
  apply: (sql: Sql) => Promise<unknown>;
}

/** Text fields of an activity row that hold a reason or a comment's words, by action. */
const ACTIVITY_TEXT: Record<string, readonly string[]> = {
  'issue.statusChanged': ['reason'],
  'comment.created': ['body'],
  'comment.updated': ['before', 'after'],
};

const refuse = (table: string, id: string, why: string): Error =>
  new Error(
    `scrub-stored-credentials: ${table} ${id} ${why}. Nothing was rewritten and nothing was skipped — fix that row and run the deploy again.`,
  );

function withheld(
  text: string,
  credentials: readonly StoredCredential[],
): { text: string; changed: boolean } {
  const out = withholdCredentials(text, credentials);
  return { text: out.text, changed: out.ids.length > 0 && out.text !== text };
}

async function credentialsByProject(sql: Sql): Promise<Map<string, StoredCredential[]>> {
  const rows = await sql<{ id: string; environments: unknown }[]>`
    SELECT id, environments FROM projects WHERE environments ? 'testCredentials'
  `;
  const out = new Map<string, StoredCredential[]>();
  for (const row of rows) {
    const held = credentialsFrom(row.environments);
    if (held.length > 0) out.set(row.id, held);
  }
  return out;
}

async function activityRewrites(sql: Sql, byProject: Map<string, StoredCredential[]>) {
  const rows = await sql<{ id: string; action: string; payload: unknown; project_id: string }[]>`
    SELECT a.id, a.action, a.payload, i.project_id FROM activity_log a
    JOIN issues i ON i.id = a.issue_id
    WHERE i.project_id IN ${sql([...byProject.keys()])}
      AND a.action IN ${sql(Object.keys(ACTIVITY_TEXT))}
    FOR UPDATE OF a
  `;
  const out: Rewrite[] = [];
  for (const row of rows) {
    const credentials = byProject.get(row.project_id) ?? [];
    if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
      throw refuse('activity_log', row.id, `(${row.action}) has a payload that is not an object`);
    }
    const payload = { ...(row.payload as Record<string, unknown>) };
    let changed = false;
    for (const key of ACTIVITY_TEXT[row.action] ?? []) {
      const value = payload[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        throw refuse(
          'activity_log',
          row.id,
          `(${row.action}) holds a ${typeof value} at payload.${key}`,
        );
      }
      const next = withheld(value, credentials);
      if (next.changed) {
        payload[key] = next.text;
        changed = true;
      }
    }
    if (changed) {
      out.push({
        table: 'activity_log',
        id: row.id,
        apply: (tx) =>
          tx`UPDATE activity_log SET payload = ${JSON.stringify(payload)}::jsonb WHERE id = ${row.id}`,
      });
    }
  }
  return out;
}

/** A plain text column, one row at a time: `kernel_transitions.reason`, `pipeline_outbox.reason`. */
async function reasonRewrites(
  sql: Sql,
  byProject: Map<string, StoredCredential[]>,
  table: 'kernel_transitions' | 'pipeline_outbox',
): Promise<Rewrite[]> {
  const projects = sql([...byProject.keys()]);
  const rows =
    table === 'kernel_transitions'
      ? await sql<{ id: string; reason: string; project_id: string }[]>`
          SELECT k.id, k.reason, i.project_id FROM kernel_transitions k
          JOIN issues i ON i.id = k.entity_id
          WHERE k.entity = 'issue' AND k.reason IS NOT NULL AND i.project_id IN ${projects}
          FOR UPDATE OF k`
      : await sql<{ id: string; reason: string; project_id: string }[]>`
          SELECT id, reason, project_id FROM pipeline_outbox
          WHERE reason IS NOT NULL AND project_id IN ${projects}
          FOR UPDATE`;
  const out: Rewrite[] = [];
  for (const row of rows) {
    const next = withheld(row.reason, byProject.get(row.project_id) ?? []);
    if (!next.changed) continue;
    out.push({
      table,
      id: row.id,
      apply: (tx) => tx`UPDATE ${tx(table)} SET reason = ${next.text} WHERE id = ${row.id}`,
    });
  }
  return out;
}

/** A question's own words: each step's prompt and `needed`, and why it was voided. A person's answer is theirs. */
async function questionRewrites(sql: Sql, byProject: Map<string, StoredCredential[]>) {
  const rows = await sql<
    { id: string; project_id: string; steps: unknown; void_reason: string | null }[]
  >`
    SELECT id, project_id, steps, void_reason FROM agent_questions
    WHERE project_id IN ${sql([...byProject.keys()])}
    FOR UPDATE
  `;
  const out: Rewrite[] = [];
  for (const row of rows) {
    const credentials = byProject.get(row.project_id) ?? [];
    if (!Array.isArray(row.steps))
      throw refuse('agent_questions', row.id, 'has steps that are not a list');
    let changed = false;
    const steps = row.steps.map((step: unknown, n: number) => {
      if (typeof step !== 'object' || step === null) {
        throw refuse('agent_questions', row.id, `has a step ${n} that is not an object`);
      }
      const next = { ...(step as Record<string, unknown>) };
      for (const key of ['prompt', 'needed']) {
        const value = next[key];
        if (value === undefined && key === 'needed') continue;
        if (typeof value !== 'string') {
          throw refuse('agent_questions', row.id, `holds a ${typeof value} at steps[${n}].${key}`);
        }
        const scrubbed = withheld(value, credentials);
        if (scrubbed.changed) {
          next[key] = scrubbed.text;
          changed = true;
        }
      }
      return next;
    });
    const voided = row.void_reason === null ? null : withheld(row.void_reason, credentials);
    if (voided?.changed) changed = true;
    if (!changed) continue;
    out.push({
      table: 'agent_questions',
      id: row.id,
      apply: (tx) =>
        tx`UPDATE agent_questions SET steps = ${JSON.stringify(steps)}::jsonb, void_reason = ${voided?.text ?? row.void_reason} WHERE id = ${row.id}`,
    });
  }
  return out;
}

/** The name this scrub's completion is recorded under in `backfill_markers`. */
export const CREDENTIAL_SCRUB_KEY = 'stored-credential-scrub';

/**
 * Rewrites every stored copy of a move's words, a comment's activity snippet and a question's
 * text that holds a project's stored test credential, to what the withhold path writes today.
 * One transaction reads with the rows locked, judges every row before writing any, and commits
 * the rewrites with the marker: a row it cannot represent aborts it by name with nothing half
 * done, and a server still writing during a rolling deploy waits rather than being overwritten.
 */
export async function scrubStoredCredentials(sql: Sql): Promise<ScrubReport> {
  const rewrites = await sql.begin(async (began) => {
    const tx = began as unknown as Sql;
    const byProject = await credentialsByProject(tx);
    const planned =
      byProject.size === 0
        ? []
        : [
            ...(await activityRewrites(tx, byProject)),
            ...(await reasonRewrites(tx, byProject, 'kernel_transitions')),
            ...(await reasonRewrites(tx, byProject, 'pipeline_outbox')),
            ...(await questionRewrites(tx, byProject)),
          ];
    for (const rewrite of planned) await rewrite.apply(tx);
    await tx`
      INSERT INTO backfill_markers (key) VALUES (${CREDENTIAL_SCRUB_KEY}) ON CONFLICT (key) DO NOTHING
    `;
    return planned;
  });
  const count = (table: Rewrite['table']): number =>
    rewrites.filter((r) => r.table === table).length;
  return {
    activity: count('activity_log'),
    kernelTransitions: count('kernel_transitions'),
    outbox: count('pipeline_outbox'),
    questions: count('agent_questions'),
  };
}

export type ScrubOnce = { ran: false } | { ran: true; report: ScrubReport };

/** The scrub, once per database: a database whose marker is written has nothing left for it. */
export async function runCredentialScrubOnce(sql: Sql): Promise<ScrubOnce> {
  const marked = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${CREDENTIAL_SCRUB_KEY}
  `;
  if ((marked[0]?.n ?? 0) > 0) return { ran: false };
  return { ran: true, report: await scrubStoredCredentials(sql) };
}
