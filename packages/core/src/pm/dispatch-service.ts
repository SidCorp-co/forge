/**
 * `forge_pm.dispatch` — the PM agent enqueuing a coder-skill job for an issue.
 *
 * The job types it could enqueue (triage / clarify / plan / code / review /
 * test / fix / release) WERE the staged lane, and it resolved which skill to
 * run by reading the issue's stage out of `skill_registrations`. ISS-895
 * removed the step table, the eight skill bodies and the registrations, so
 * there is no longer a job this function could produce that any runner would
 * accept — the staged types are absent from `RUNNER_CAPABILITIES` and would
 * fail `runner_unsupported_type` on dispatch.
 *
 * It refuses by name rather than being deleted: `forge_project_pm` still
 * exposes the `dispatch` action, and removing that action from the tool
 * surface belongs to the MCP-cleanup issue this one blocks. A refusal an
 * operator can read beats an action that returns a job nothing will run.
 */

import type { JobType, ModelTier } from '../db/schema.js';

export type PmDispatchInput = {
  projectId: string;
  issueId: string;
  jobType: JobType;
  reason: string;
  payload?: Record<string, unknown> | undefined;
  modelTier?: ModelTier | undefined;
};

// cm:guard throw, never return a shaped `{ ok: false }`. The caller is an agent, and a soft result is read as "this issue was not eligible today" — it would keep calling. The staged lane is gone for every project and every issue, which is a permanent condition and has to arrive as one.
export async function dispatchPmJob(input: PmDispatchInput, _createdBy: string): Promise<never> {
  throw new Error(
    `BAD_REQUEST: PM step dispatch was removed with the staged lane (ISS-895) — jobType "${input.jobType}" has no lane to run in. An autonomous project dispatches one job type, \`drive\`, from the entry status; move the issue to \`open\` instead.`,
  );
}
