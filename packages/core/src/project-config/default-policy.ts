import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { checkPolicy } from './rules.js';
import { type PolicyDocument, policyDocumentSchema } from './schema.js';

// cm:why each outlives the run that calls it — a cron, a workflow, a trigger, a wake-up.
const DRIVER_DENY = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'Workflow',
  'RemoteTrigger',
  'ScheduleWakeup',
] as const;

const DEFAULT_POLICY_PROFILE = 'driver';

const DRIVER_STATE = { model: 'opus', permissions: DEFAULT_POLICY_PROFILE } as const;

// cm:why projects/service.ts:createProject writes it as revision 1, so no default is invented later.
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
