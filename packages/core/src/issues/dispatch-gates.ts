import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  buildsWorkflowOf,
  type DispatchGateCode,
  type DispatchGateError,
  designUnapprovedSql,
  type GateReader,
  isDispatchGateError,
} from './ports.js';

export { type DispatchGateCode, type DispatchGateError, isDispatchGateError };

// Every dispatch door asks the gate here, so none can skip the design gate
export function dispatchGateHeldSql(issueId: SQL): SQL {
  return sql`(${designUnapprovedSql(issueId)})`;
}

export async function assertDispatchGatesForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  await assertDesignsApprovedForSeqs(projectId, seqs);
}

export async function assertDispatchGatesForIssue(
  projectId: string,
  issueId: string,
  executor?: GateReader,
): Promise<void> {
  await assertDesignApprovedForIssue(projectId, issueId, executor);
}

export async function dispatchGatesOf(issueId: string) {
  return { buildsWorkflow: await buildsWorkflowOf(issueId) };
}
