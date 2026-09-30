import { checkPolicy } from './rules.js';
import { type PolicyDocument, policyDocumentSchema, SCHEMA_BASE } from './schema.js';

// cm:why the tools a driver run must never reach whatever else a project denies: each one outlives
// the run that calls it (a cron, a workflow, a remote trigger, a wake-up), so a run that ends has
// still acted. Carried over from the deny list every stage got by default before policy-v1.
export const DRIVER_DENY = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'Workflow',
  'RemoteTrigger',
  'ScheduleWakeup',
] as const;

export const DEFAULT_POLICY_PROFILE = 'driver';

const DRIVER_STATE = { model: 'opus', permissions: DEFAULT_POLICY_PROFILE } as const;

// cm:why written at project creation (projects/service.ts:createProject) as a real revision 1, so
// a new project dispatches under a document its owner can read and change, never under defaults
// the dispatcher invents; a project created before this has none and is refused by name instead.
export const DEFAULT_POLICY: PolicyDocument = {
  $schema: `${SCHEMA_BASE}/policy-v1.json`,
  version: 1,
  qa: 'self',
  intake: { mode: 'auto' },
  permissions: { [DEFAULT_POLICY_PROFILE]: { deny: [...DRIVER_DENY] } },
  states: { open: DRIVER_STATE, in_progress: DRIVER_STATE, needs_info: DRIVER_STATE },
};

// cm:guard a default the schema or the rules refuse would be written into every new project and
// then refused at its first dispatch; refuse to load instead.
const parsed = policyDocumentSchema.safeParse(DEFAULT_POLICY);
const refusals = parsed.success ? checkPolicy(parsed.data) : [];
if (!parsed.success || refusals.length > 0) {
  throw new Error(
    `project-config/default-policy.ts: DEFAULT_POLICY is not a valid policy-v1 document: ${
      parsed.success ? JSON.stringify(refusals) : parsed.error.message
    }`,
  );
}
