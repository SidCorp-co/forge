import { z } from 'zod';
import { pluginDesignationSchema } from '../lib/plugin-designation.js';

const agentConfigSchema = z
  .object({
    /** Read by `lib/plugin-designation.ts:readPluginDesignations`, unioned per device by `GET /api/devices/me/plugins`. */
    plugins: z.array(pluginDesignationSchema).optional(),
  })
  .strict();

type AgentConfigDocument = z.infer<typeof agentConfigSchema>;

export type AgentConfigKey = keyof AgentConfigDocument;

/** Every declared key, in declaration order. */
export const AGENT_CONFIG_KEYS = Object.keys(agentConfigSchema.shape) as AgentConfigKey[];

const AGENT_CONFIG_DOORS: Record<AgentConfigKey, string> = {
  plugins: '`PATCH /api/projects/:id/plugins`',
};

/**
 * The keys removed from the column by migration `0285`, each with the thing that owns its value.
 *
 * Retired BY NAME rather than dropped: a key deleted from a non-strict zod object turns an
 * operator's save into a 200 and a silent discard, which is the defect ISS-994 and ISS-1000
 * established and the one this retirement exists to avoid repeating.
 */
const RETIRED_AGENT_CONFIG_KEYS: Record<string, string> = {
  repoPath:
    "agentConfig.repoPath decides nothing — a checkout is a path on one box, so it lives on that box's device binding (`forge-runner bind <slug> --path <dir>`, or PATCH /api/projects/:id/runners/:runnerId { repoPath }). Remove repoPath from agentConfig.",
  baseBranch:
    "agentConfig.baseBranch decides nothing — the branch work is cut from is the project document's `source.git.defaultBranch`, written with PUT /api/projects/:id/config. Remove baseBranch from agentConfig.",
  productionBranch:
    "agentConfig.productionBranch names a column that does not exist: the branch production deploys from is the project document's production environment `deploysFrom`, and how a change reaches it is that document's `promotions` (`PUT /api/projects/:id/config`). Remove productionBranch from agentConfig.",
  activeDeviceId:
    "agentConfig.activeDeviceId decides nothing — no box is a project's default: work goes to a device bound to the project whose binding names a checkout. Remove activeDeviceId from agentConfig.",
  runnerFallback:
    'agentConfig.runnerFallback decides nothing — ISS-232 Phase 3 replaced the type-chain fallback with a deterministic primary-then-standby pick, and no selector has read this key since. Remove runnerFallback from agentConfig.',
};

/** The message a raw `agentConfig` record carrying a DECLARED key is refused with. */
function agentConfigDoorMessage(key: AgentConfigKey): string {
  return `agentConfig is no longer a field on PATCH /api/projects/:id — every value it held has a door of its own, so a wholesale record can no longer overwrite a sibling key a concurrent write just set. Write \`${key}\` through ${AGENT_CONFIG_DOORS[key]}.`;
}

const AGENT_CONFIG_CLEAR_GUIDE =
  'agentConfig is no longer a field on PATCH /api/projects/:id, and it cannot be cleared wholesale. Clear each value through its own door instead: send `plugins` as null on PATCH /api/projects/:id/plugins.';

function agentConfigUndeclaredMessage(key: string): string {
  return `agentConfig.${key} is not a key this project's configuration declares, so nothing would ever read it. The declared keys are ${AGENT_CONFIG_KEYS.join(', ')}, each written through its own door. Refused by name rather than stored, and rather than answered 200 and dropped.`;
}

export function refuseAgentConfigRecord(
  raw: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ['agentConfig'],
  alreadyNamed: ReadonlySet<string> = new Set(),
): void {
  if (raw === null || raw === undefined) {
    ctx.addIssue({ code: 'custom', path, message: AGENT_CONFIG_CLEAR_GUIDE });
    return;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `agentConfig is no longer a field on PATCH /api/projects/:id, and what arrived is a ${Array.isArray(raw) ? 'list' : typeof raw} rather than a document in any case. ${AGENT_CONFIG_CLEAR_GUIDE}`,
    });
    return;
  }
  let spoke = false;
  const declared = new Set<string>(AGENT_CONFIG_KEYS);
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    spoke = true;
    if (alreadyNamed.has(key)) continue;
    const retired = RETIRED_AGENT_CONFIG_KEYS[key];
    if (retired) {
      ctx.addIssue({ code: 'custom', path: [...path, key], message: retired });
      continue;
    }
    if (declared.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, key],
        message: agentConfigDoorMessage(key as AgentConfigKey),
      });
      continue;
    }
    ctx.addIssue({
      code: 'custom',
      path: [...path, key],
      message: agentConfigUndeclaredMessage(key),
    });
  }
  if (!spoke) ctx.addIssue({ code: 'custom', path, message: AGENT_CONFIG_CLEAR_GUIDE });
}
