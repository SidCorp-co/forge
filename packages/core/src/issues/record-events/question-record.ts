// A `forge-record: question` comment is a question the run asked, so it is a Question row: the HOP
// run's master asked the owner through one (8e5533b8 on ISS-1), no row was written, and the issue
// read "a person paused it" while the owner was the one owed (FB-55's class). The row is keyed by
// the comment's own id, so a re-mirror of the same comment asks nothing twice.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import type { ForgeRecord } from '../../messaging/forge-record.js';
import type { Actor } from '../activity.js';
import { askParkQuestion } from '../ports.js';

/** Addressees a question record names that are not a person: the run asks itself nothing. */
const AGENT_ADDRESSEES = new Set(['agent', 'run', 'master', 'self']);

function promptOf(record: ForgeRecord, body: string): string {
  const named = record.fields.find((f) => f.key === 'prompt' || f.key === 'question')?.value;
  if (named?.trim()) return named.trim();
  const prose = `${body.slice(0, record.at)} ${body.slice(record.to)}`
    .replace(/^#+\s*question\s*$/gim, '')
    .replace(/`forge-record:[^`]*`/g, '')
    .trim();
  return prose || 'The run asked which of these readings holds.';
}

function neededOf(record: ForgeRecord): string {
  const readings = record.fields.filter((f) => f.key === 'reading').map((f) => f.value.trim());
  const needed = record.fields.find((f) => f.key === 'needs' || f.key === 'needed')?.value.trim();
  if (readings.length === 0) {
    return (
      needed ||
      'the run did not say what would settle this — answer with whatever it needs to carry on'
    );
  }
  const listed = readings.map((r, i) => `(${i + 1}) ${r}`).join('\n');
  return `${needed ? `${needed}\n` : ''}which reading holds, by number or in your own words:\n${listed}`;
}

export async function mintRecordQuestion(
  comment: { id: string; issueId: string; body: string },
  record: ForgeRecord,
  actor: Actor,
  tx: Tx,
): Promise<string[]> {
  if (actor.agency !== 'agent') return [];
  const to =
    record.fields
      .find((f) => f.key === 'to')
      ?.value.trim()
      .toLowerCase() ?? '';
  if (AGENT_ADDRESSEES.has(to)) return [];
  const [issue] = await tx
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, comment.issueId))
    .limit(1);
  if (!issue) return [];
  if (ISSUE_TERMINAL_STATUSES.includes(issue.status as IssueStatus)) {
    return [
      `QUESTION_ISSUE_TERMINAL: this comment's \`forge-record: question\` is stored as prose only — the issue is \`${issue.status}\`, so no answer could reach the work it asks about`,
    ];
  }
  const asked = (await tx.execute(
    sql`SELECT 1 FROM agent_questions WHERE id = ${comment.id}`,
  )) as unknown as unknown[];
  if (asked.length > 0) return [];
  await askParkQuestion(tx, {
    id: comment.id,
    projectId: issue.projectId,
    issueId: comment.issueId,
    prompt: promptOf(record, comment.body),
    needed: neededOf(record),
  });
  return [];
}
