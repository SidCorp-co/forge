import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  assertWaitsSettledForIssue,
  assertWaitsSettledForSeqs,
  ContractWaitUnsettledError,
  waitUnsettledSql,
} from '../ecosystem/waits/gate.js';
import { waitsOnContractsOf } from '../ecosystem/waits/read.js';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  buildsWorkflowOf,
  designUnapprovedSql,
} from '../workflows/build-gate.js';
import { WorkflowDesignNotApprovedError } from '../workflows/design.js';

export type DispatchGateError = WorkflowDesignNotApprovedError | ContractWaitUnsettledError;
export type DispatchGateCode = DispatchGateError['code'];

export const isDispatchGateError = (err: unknown): err is DispatchGateError =>
  err instanceof WorkflowDesignNotApprovedError || err instanceof ContractWaitUnsettledError;

// cm:why every dispatch door asks the pair here, so none can check the design gate and forget the contract wait
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
): Promise<void> {
  await assertDesignApprovedForIssue(projectId, issueId);
  await assertWaitsSettledForIssue(projectId, issueId);
}

export async function dispatchGatesOf(issueId: string, projectId: string) {
  const [buildsWorkflow, waitsOnContracts] = await Promise.all([
    buildsWorkflowOf(issueId),
    waitsOnContractsOf(issueId, projectId),
  ]);
  return { buildsWorkflow, waitsOnContracts };
}
