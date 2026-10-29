import type { BindingTargetRefusal, VerifyBindingTargetArgs } from '../index.js';
import { listActiveDeployBindingsForProvider } from '../index.js';
import { agentSwitchGate } from './room-handlers.js';

type Settled =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; refusals: BindingTargetRefusal[] };

/**
 * A binding that carries `support` names exactly one room: one group, one session (REQ-75 BC-10).
 * One that carries `operations` names rooms each answered by a session of its own (BC-20). One that
 * carries `agent` names any number of rooms, all answered by the project's one channel agent
 * (REQ-77 BC-1). A binding carries at most one of the three, so no group is answered twice; one with
 * none is the team assistant's and keeps any number of rooms. `owner_mode` is granted only to a
 * channel agent (REQ-77 BC-20). Whatever it carries, the groups it names in `outsideRids` are
 * answered by an agent outside Forge, so a group named in `rids` too would be answered twice:
 * refused (REQ-75 r6).
 */
export async function settleSupportRoom(args: {
  bindingId: string;
  config: Record<string, unknown>;
  held: Record<string, unknown> | null;
}): Promise<Settled> {
  const support = args.config.support !== undefined && args.config.support !== null;
  const operations = args.config.operations !== undefined && args.config.operations !== null;
  const answered = Array.isArray(args.config.rids) ? args.config.rids : [];
  const outside = Array.isArray(args.config.outsideRids) ? args.config.outsideRids : [];
  const twice = outside.flatMap((rid, i) => (answered.includes(rid) ? [{ rid, i }] : []));
  if (twice.length > 0) {
    return {
      ok: false,
      refusals: twice.map(({ rid, i }) => ({
        code: 'SUPPORT_ROOM_TWO_KINDS' as const,
        path: `/outsideRids/${i}`,
        detail: `group ${rid} is in \`rids\`, answered by Forge, and in \`outsideRids\`, answered by an agent outside Forge; name it in one of the two`,
      })),
    };
  }
  const agent = args.config.agent !== undefined && args.config.agent !== null;
  const kinds = [support && 'support', operations && 'operations', agent && 'agent'].filter(
    (k): k is string => Boolean(k),
  );
  if (kinds.length > 1) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SUPPORT_ROOM_TWO_KINDS',
          path: `/${kinds[1]}`,
          detail: `a binding's rooms are a support group (\`support\`), operations rooms (\`operations\`) or a channel agent's (\`agent\`), never more than one; this one carries ${kinds.map((k) => `\`${k}\``).join(' and ')}`,
        },
      ],
    };
  }
  const ownerMode = (block: unknown) =>
    ((block as { grants?: { abilities?: string[] } } | null)?.grants?.abilities ?? []).includes(
      'owner_mode',
    );
  if (support && ownerMode(args.config.support)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SUPPORT_OWNER_MODE_NOT_AGENT',
          path: '/support/grants/abilities',
          detail:
            "owner_mode is granted only to a channel agent: move this binding's block from `support` to `agent`, or drop owner_mode",
        },
      ],
    };
  }
  const checksRefused = checkRefusals(args.config, { support, agent, answered });
  if (checksRefused.length > 0) return { ok: false, refusals: checksRefused };
  // an operations binding attaches any number of rooms, each with a session of its own (BC-20)
  if (!support) return { ok: true, config: args.config };
  const rids = Array.isArray(args.config.rids) ? args.config.rids : [];
  if (rids.length !== 1) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SUPPORT_ROOM_NOT_ONE_GROUP',
          path: '/rids',
          detail: `a support binding names exactly one Rocket.Chat group, which its one session answers; this one names ${rids.length}. Bind each group from its own project, or drop support to keep a team room.`,
        },
      ],
    };
  }
  return { ok: true, config: args.config };
}

/**
 * Scheduled checks are a channel agent's (REQ-77 BC-13): refused on a support group's block, and a
 * check naming a group the binding does not answer is refused, since its finding would go nowhere.
 */
function checkRefusals(
  config: Record<string, unknown>,
  held: { support: boolean; agent: boolean; answered: readonly unknown[] },
): BindingTargetRefusal[] {
  const checksOf = (block: unknown) =>
    ((block as { checks?: { name: string; rid: string }[] } | null)?.checks ?? []) as {
      name: string;
      rid: string;
    }[];
  if (held.support && checksOf(config.support).length > 0) {
    return [
      {
        code: 'SUPPORT_CHECK_NOT_AGENT',
        path: '/support/checks',
        detail:
          "scheduled checks are a channel agent's: move this binding's block from `support` to `agent`, or drop checks",
      },
    ];
  }
  if (!held.agent) return [];
  return checksOf(config.agent).flatMap((c, i) =>
    held.answered.includes(c.rid)
      ? []
      : [
          {
            code: 'SUPPORT_CHECK_ROOM_UNKNOWN' as const,
            path: `/agent/checks/${i}/rid`,
            detail: `check ${c.name} posts in group ${c.rid}, which this binding's agent does not answer; name one of ${held.answered.join(', ') || 'the groups in `rids`'}`,
          },
        ],
  );
}

/**
 * A group the binding held in `outsideRids`, answered by a bot outside Forge, joins the channel agent
 * only through its switch (REQ-77 BC-16): the support domain names what still stands before it.
 */
async function switchRefusals(args: VerifyBindingTargetArgs): Promise<BindingTargetRefusal[]> {
  if (!args.config.agent) return [];
  const rids = Array.isArray(args.config.rids) ? (args.config.rids as string[]) : [];
  const held = args.held ?? {};
  const heldAnswered =
    held.agent && Array.isArray(held.rids) ? new Set(held.rids as string[]) : new Set<string>();
  const joining = rids.flatMap((rid, i) => (heldAnswered.has(rid) ? [] : [{ rid, i }]));
  if (joining.length === 0) return [];
  const heldOutside = Array.isArray(held.outsideRids) ? (held.outsideRids as string[]) : [];
  const refused = await agentSwitchGate().refusals({
    projectId: args.projectId,
    joining,
    heldOutside,
  });
  return refused.map((r) => ({ code: 'AGENT_SWITCH_NOT_READY' as const, ...r }));
}

/**
 * A support group's grant names deploy targets by the project's own deploy bindings (REQ-75 r5
 * BC-27): one that is not an active Coolify binding of this project is refused by name at bind, so
 * a grant never names what nobody can deploy. A group an outside bot answered joins a channel agent
 * only through its switch (REQ-77 BC-16).
 */
export async function verifySupportGrant(
  args: VerifyBindingTargetArgs,
): Promise<BindingTargetRefusal[]> {
  const switching = await switchRefusals(args);
  if (switching.length > 0) return switching;
  type Granting = { grants?: { deployTargets?: string[] } } | undefined;
  const block = args.config.agent ? 'agent' : 'support';
  const named = (args.config[block] as Granting)?.grants?.deployTargets ?? [];
  if (named.length === 0) return [];
  const bound = new Set(
    (await listActiveDeployBindingsForProvider(args.projectId, 'coolify')).map((p) => p.binding.id),
  );
  return named.flatMap((id, i) =>
    bound.has(id)
      ? []
      : [
          {
            code: 'SUPPORT_GRANT_TARGET_UNKNOWN' as const,
            path: `/${block}/grants/deployTargets/${i}`,
            detail: `${id} is not an active deploy binding of this project, so this room could never deploy it; name one of ${[...bound].join(', ') || 'none — bind a deploy target first'}`,
          },
        ],
  );
}
