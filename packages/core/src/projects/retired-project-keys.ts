import type { z } from 'zod';
import { RETIRED_STATE_CONTEXT_MESSAGE } from './agent-config.js';
import { refuseAgentConfigRecord } from './agent-config-schema.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

/** The refusal for a key a strict project body does not declare: named, never stripped to a 200. */
export function undeclaredFieldError(door: string, fields: readonly string[]) {
  return (issue: { code?: string; keys?: readonly string[] }) => {
    if (issue.code !== 'unrecognized_keys' || !issue.keys) return undefined;
    const named = issue.keys.map((k) => `\`${k}\``).join(', ');
    return `${named} ${issue.keys.length === 1 ? 'is not a field' : 'are not fields'} of ${door}, so nothing would read ${issue.keys.length === 1 ? 'it' : 'them'}: refused rather than answered 200 and dropped. The fields are ${fields.join(', ')}.`;
  };
}

export const RETIRED_PROJECT_FIELDS: Record<string, string> = {
  baseBranch:
    "`baseBranch` is not a project field: the branch work is cut from and lands on is the project document's `source.git.defaultBranch`. Read it with GET /api/projects/:id/config and write it with PUT /api/projects/:id/config { baseRevision, document }.",
  webhookSecret:
    "`webhookSecret` is not a project field: no route reads a project webhook secret. A provider's webhook to POST /api/webhooks/in/:slug is verified with the secret of the integration binding it is for, and a delivery naming no provider is refused with WEBHOOK_ROUTE_REMOVED.",
  apiKey:
    '`apiKey` is not a project field: no route authenticated a project API key, so there is none to set or rotate. A box authenticates with its device credential and a person or agent with an access token.',
  repoUrl:
    "`repoUrl` is not a project field: the repository is the project document's `source.git.repository` (`host/owner/repo`, e.g. `github.com/SidCorp-co/forge`), and the clone remote is derived from it — SSH where a deploy key is attached, HTTPS otherwise. Read it with GET /api/projects/:id/config and write it with PUT /api/projects/:id/config { baseRevision, document }.",
  workspaceSetup:
    "`workspaceSetup` is not a project field: how a checkout is brought to a buildable state is the project document's `workspace.setup`. Read it with GET /api/projects/:id/config and write it with PUT /api/projects/:id/config { baseRevision, document }.",
  repoPath:
    "`repoPath` is not a project field: a checkout is a path on one box, so it lives on that box's device binding. Set it with `forge-runner bind <slug> --path <dir>`, or PATCH /api/projects/:id/runners/:runnerId { repoPath }.",
  defaultDeviceId:
    "`defaultDeviceId` is not a project field: no box is a project's default. A job or turn goes to a device bound to the project (POST /api/projects/:id/runners), and only to one whose binding names a checkout.",
};

/** PATCH /api/projects/:id does not rename: the name has one source, the project document. */
export const PROJECT_NAME_MOVED =
  "`name` is not written by PATCH /api/projects/:id: a project's name is its project document's `project.name`, and the `projects` row carries it only as that document's projection. Read the document with GET /api/projects/:id/config and write it with PUT /api/projects/:id/config { baseRevision, document }.";

/** The retirement message for each of `keys` the device binding replaced, joined; `null` for none. */
export function retiredProjectFieldsMessage(keys: readonly string[]): string | null {
  const said = keys.flatMap((k) => (RETIRED_PROJECT_FIELDS[k] ? [RETIRED_PROJECT_FIELDS[k]] : []));
  return said.length === 0 ? null : said.join(' ');
}

export function refuseRetiredProjectFields(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [field, message] of Object.entries(RETIRED_PROJECT_FIELDS)) {
    if (field in raw) ctx.addIssue({ code: 'custom', path: [field], message });
  }
}

export function refuseRetiredProjectKeys(raw: unknown, ctx: z.RefinementCtx): void {
  if (!raw || typeof raw !== 'object') return;
  const retired = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const body = raw as { stateContext?: unknown; agentConfig?: unknown };
  refuseRetiredProjectFields(raw, ctx);
  if ('name' in body) retired(['name'], PROJECT_NAME_MOVED);
  if ('stateContext' in body) retired(['stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  if (!('agentConfig' in body)) return;
  const ac = body.agentConfig as Record<string, unknown> | null | undefined;
  if (!ac || typeof ac !== 'object') {
    refuseAgentConfigRecord(ac, ctx);
    return;
  }
  if ('stateContext' in ac) retired(['agentConfig', 'stateContext'], RETIRED_STATE_CONTEXT_MESSAGE);
  if ('projectFacts' in ac) retired(['agentConfig', 'projectFacts'], RETIRED_PROJECT_FACTS_MESSAGE);
  if ('projectFactsConfig' in ac) {
    retired(['agentConfig', 'projectFactsConfig'], RETIRED_PROJECT_FACTS_CONFIG_MESSAGE);
  }
  refuseAgentConfigRecord(ac, ctx, ['agentConfig'], NAMED_ABOVE);
}

/** The three keys whose retirement message is added above, so the record walk does not repeat them. */
const NAMED_ABOVE: ReadonlySet<string> = new Set([
  'stateContext',
  'projectFacts',
  'projectFactsConfig',
]);
