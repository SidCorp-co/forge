import type { JobType, ModelTier } from '../db/schema.js';

export type PmDispatchInput = {
  projectId: string;
  issueId: string;
  jobType: JobType;
  reason: string;
  payload?: Record<string, unknown> | undefined;
  modelTier?: ModelTier | undefined;
};

export async function dispatchPmJob(input: PmDispatchInput, _createdBy: string): Promise<never> {
  throw new Error(
    `BAD_REQUEST: PM step dispatch was removed with the staged lane (ISS-895) — jobType "${input.jobType}" has no lane to run in. An autonomous project dispatches one job type, \`drive\`, from the entry status; move the issue to \`open\` instead.`,
  );
}
