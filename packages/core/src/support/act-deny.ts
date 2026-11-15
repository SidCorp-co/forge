// The acts a room agent may not run on its own (ISS-1243 item 16, owner 2026-11-15: "as many grants
// as possible to support users, short of an act with serious consequence"). The project document's
// `agentDeny` names them (production deploy, data deletion, money movement, credential change; all
// four when absent, none when empty). Each is refused SUPPORT_ACT_DENIED by name, before anything is
// proposed or run, and raised in the project's technical channel (`technical-channel.ts`), so a
// person who may decide it sees it and the work thread is told only that it is in hand. This is a
// gate on top of the grants, never around them: an act the grant does not hold is refused as before.

import { AGENT_DENY_CLASSES, type AgentDenyClass } from '@forge/contracts/support-technical';
import { supportApisOf } from '../integrations/support-api/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { raiseTechnical } from './technical-channel.js';

/** What each denied class is, in the words the refusal and the technical channel use. */
const DENY_MEANING: Record<AgentDenyClass, string> = {
  production_deploy: 'a production deploy',
  data_deletion: 'deleting data',
  money_movement: 'moving money',
  credential_change: 'changing a credential',
};

const DATA_DELETION =
  /\brm\s+-[a-z]*r[a-z]*f?\b|\bdrop\s+(table|database|schema)\b|\btruncate\b|\bdelete\s+from\b|\bdeleteMany\b|\bpurge\b/i;
const MONEY = /refund|payout|transfer|charge|payment|withdraw|top.?up|disburse|invoice.?pay/i;
const CREDENTIAL =
  /passw(or)?d|credential|secret|api.?key|token|ssh-keygen|chpasswd|rotate.?(key|token|secret)/i;

/** The act as the gate reads it: what it is and the words that say what it would do. */
type Gated =
  | { action: 'deploy'; thread: string; target: string }
  | { action: 'command'; thread: string; command: string }
  | { action: 'propose_fix' | 'owner_act'; thread: string; tool: string };

function gatedOf(input: { action: string } & Record<string, unknown>): Gated | null {
  const thread = typeof input.thread === 'string' ? input.thread : null;
  if (!thread) return null;
  if (input.action === 'deploy' && typeof input.target === 'string')
    return { action: 'deploy', thread, target: input.target };
  if (input.action === 'command' && typeof input.command === 'string')
    return { action: 'command', thread, command: input.command };
  if (
    (input.action === 'propose_fix' || input.action === 'owner_act') &&
    typeof input.tool === 'string'
  )
    return { action: input.action, thread, tool: input.tool };
  return null;
}

/** Whether the deploy target is a production environment's, by the project document's tiers. */
async function deploysProduction(projectId: string, target: string): Promise<boolean> {
  const environments = (await readProjectDocument(projectId))?.document.environments ?? {};
  return Object.values(environments).some(
    (e) =>
      e.tier === 'production' &&
      e.deployment !== undefined &&
      'binding' in e.deployment &&
      e.deployment.binding === target,
  );
}

/** The words a support-API tool goes by: its name, method, path and summary, where it is bound. */
async function toolWords(
  projectId: string,
  name: string,
): Promise<{ words: string; del: boolean }> {
  const tool = await supportApisOf(projectId)
    .then((apis) => apis.tools.find((t) => t.name === name) ?? null)
    .catch(() => null);
  if (!tool) return { words: name, del: false };
  return {
    words: `${tool.name} ${tool.path} ${tool.summary}`,
    del: tool.method.toUpperCase() === 'DELETE',
  };
}

/** Which class the act falls in, or null for an act no class names. */
async function classOf(projectId: string, act: Gated): Promise<AgentDenyClass | null> {
  if (act.action === 'deploy')
    return (await deploysProduction(projectId, act.target)) ? 'production_deploy' : null;
  const { words, del } =
    act.action === 'command'
      ? { words: act.command, del: false }
      : await toolWords(projectId, act.tool);
  if (del || DATA_DELETION.test(words)) return 'data_deletion';
  if (MONEY.test(words)) return 'money_movement';
  if (CREDENTIAL.test(words)) return 'credential_change';
  return null;
}

/** The classes the project keeps from its room agents: its `agentDeny`, or all four. */
export async function deniedClassesOf(projectId: string): Promise<readonly AgentDenyClass[]> {
  return (await readProjectDocument(projectId))?.document.agentDeny ?? AGENT_DENY_CLASSES;
}

/**
 * Null where the act may go on to its grant's gate; otherwise the refusal, recorded on the thread,
 * after the act was raised in the technical channel (or naming why it could not be).
 */
export async function deniedActRefusal(
  room: RoomRow,
  input: { action: string } & Record<string, unknown>,
): Promise<Outcome<never> | null> {
  const act = gatedOf(input);
  if (!act) return null;
  const found = await classOf(room.projectId, act);
  if (!found || !(await deniedClassesOf(room.projectId)).includes(found)) return null;
  const what =
    act.action === 'deploy'
      ? `deploy ${act.target}`
      : act.action === 'command'
        ? act.command
        : act.tool;
  const raised = await raiseTechnical(room, {
    thread: act.thread,
    need: 'approval',
    text: `A room agent was asked for ${DENY_MEANING[found]} (${act.action}: ${what}), which this project keeps from its room agents; a person who may decide it acts on it.`,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: act.thread,
    kind: 'refused',
    actorKind: 'session',
    tool: act.action,
    input,
    output: { code: 'SUPPORT_ACT_DENIED', class: found, raised: raised.ok },
  });
  const where = raised.ok
    ? "it was raised in the project's technical channel, so tell the thread it is in hand"
    : `it could not be raised in the technical channel (${raised.refusals.map((r) => r.detail).join('; ')})`;
  return no(
    'SUPPORT_ACT_DENIED',
    '/action',
    `${act.action} here is ${DENY_MEANING[found]}, which this project keeps from its room agents (the project document's \`agentDeny\`, all of production_deploy, data_deletion, money_movement and credential_change when it names none): nothing was proposed or run, and ${where}.`,
  );
}
