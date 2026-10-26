import type { BindingTargetRefusal } from '../index.js';

type Settled =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; refusals: BindingTargetRefusal[] };

/**
 * A binding that carries `support` names exactly one room: one group, one session (REQ-75 BC-10).
 * A binding without it is the team assistant's and keeps any number of rooms, as before.
 */
export async function settleSupportRoom(args: {
  bindingId: string;
  config: Record<string, unknown>;
  held: Record<string, unknown> | null;
}): Promise<Settled> {
  if (args.config.support === undefined || args.config.support === null) {
    return { ok: true, config: args.config };
  }
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
