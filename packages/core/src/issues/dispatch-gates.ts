import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  assertWaitsSettledForIssue,
  assertWaitsSettledForSeqs,
  buildsWorkflowOf,
  type DispatchGateCode,
  type DispatchGateError,
  designUnapprovedSql,
  type GateReader,
  isDispatchGateError,
  waitsOnContractsOf,
  waitUnsettledSql,
} from './ports.js';

export { type DispatchGateCode, type DispatchGateError, isDispatchGateError };

// Every dispatch door asks the pair here, so none can check the design gate and forget the contract wait
export function dispatchGateHeldSql(issueId: SQL): SQL {
  return sql`(${designUnapprovedSql(issueId)} OR ${waitUnsettledSql(issueId)})`;
}

export async function assertDispatchGatesForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  await assertDesignsApprovedForSeqs(projectId, seqs);
  await assertWaitsSettledForSeqs(projectId, seqs);
}

export async function assertDispatchGatesForIssue(
  projectId: string,
  issueId: string,
  executor?: GateReader,
): Promise<void> {
  await assertDesignApprovedForIssue(projectId, issueId, executor);
  await assertWaitsSettledForIssue(projectId, issueId, executor);
}

export async function dispatchGatesOf(issueId: string, projectId: string) {
  const [buildsWorkflow, waitsOnContracts] = await Promise.all([
    buildsWorkflowOf(issueId),
    waitsOnContractsOf(issueId, projectId),
  ]);
  return { buildsWorkflow, waitsOnContracts };
}
