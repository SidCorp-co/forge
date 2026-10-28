import type { BindingTargetRefusal, VerifyBindingTargetArgs } from '../index.js';
import { listActiveDeployBindingsForProvider } from '../index.js';

type Settled =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; refusals: BindingTargetRefusal[] };

/**
 * A binding that carries `support` names exactly one room: one group, one session (REQ-75 BC-10).
 * One that carries `operations` names rooms each answered by a session of its own (BC-20), and never
 * `support` beside it. A binding with neither is the team assistant's and keeps any number of rooms.
 */
export async function settleSupportRoom(args: {
  bindingId: string;
  config: Record<string, unknown>;
  held: Record<string, unknown> | null;
}): Promise<Settled> {
  const support = args.config.support !== undefined && args.config.support !== null;
  const operations = args.config.operations !== undefined && args.config.operations !== null;
  if (support && operations) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SUPPORT_ROOM_TWO_KINDS',
          path: '/operations',
          detail:
            "a binding's rooms are a support group (`support`) or operations rooms (`operations`), never both; bind each from its own binding",
        },
      ],
    };
  }
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
 * A support group's grant names deploy targets by the project's own deploy bindings (REQ-75 r5
 * BC-27): one that is not an active Coolify binding of this project is refused by name at bind, so
 * a grant never names what nobody can deploy.
 */
export async function verifySupportGrant(
  args: VerifyBindingTargetArgs,
): Promise<BindingTargetRefusal[]> {
  const support = args.config.support as { grants?: { deployTargets?: string[] } } | undefined;
  const named = support?.grants?.deployTargets ?? [];
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
            path: `/support/grants/deployTargets/${i}`,
            detail: `${id} is not an active deploy binding of this project, so this room could never deploy it; name one of ${[...bound].join(', ') || 'none — bind a deploy target first'}`,
          },
        ],
  );
}
