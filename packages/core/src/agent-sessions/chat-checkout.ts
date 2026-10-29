// How a confined turn shows its session the project's checkout (REQ-75 r5 BC-27): read-only, not at
// all, as the room's own writable working copy of the development branch, or — for a channel agent in
// owner mode (ISS-765) — as its own clone of the repository, git directory included, whose pushes and
// `gh` calls hold a credential for that repository alone. The view is on the turn
// frame, and only a box that declares it can scope a checkout is handed one: an older runner ignores
// the field and would mount the checkout writable, which is what the room was not granted.

import { SUPPORT_BOX_CAPABILITIES } from '@forge/contracts/support';
import { requireCheckoutScoping } from './chat-device.js';

/**
 * A room's view of the checkout: read-only, none (an empty folder), a writable working copy of
 * `base` the box keeps under `key` for a room granted build, or an owner-mode agent's own clone of
 * `base` under `key`, reaching `hosts` besides the model and core (the repository's git and API
 * hosts).
 */
export type CheckoutView =
  | { mode: 'read' }
  | { mode: 'none' }
  | { mode: 'build'; base: string; key: string }
  | { mode: 'own'; base: string; key: string; hosts: string[] };

/** The box capability an owner-mode agent's own clone needs (ISS-765). */
const OWNER_CHECKOUT_CAPABILITY = SUPPORT_BOX_CAPABILITIES.owner;

/** The box capabilities a checkout view needs (`@forge/contracts/support:SUPPORT_BOX_CAPABILITIES`). */
const CHECKOUT_VIEW_NEEDS: Record<CheckoutView['mode'], readonly string[]> = {
  read: ['chatCheckoutModes'],
  none: ['chatCheckoutModes'],
  build: ['chatCheckoutModes', 'supportBuilds'],
  own: ['chatCheckoutModes', OWNER_CHECKOUT_CAPABILITY],
};

/** Refuses a view on a turn that is not confined, or on a box that cannot scope it. */
export async function requireCheckoutView(
  view: CheckoutView,
  turn: { sessionId: string; deviceId: string; confined: boolean },
): Promise<void> {
  if (!turn.confined) {
    throw new Error(
      `dispatchChatTurn: a checkout view (${view.mode}) is a confined session's, and session ${turn.sessionId} is not confined`,
    );
  }
  await requireCheckoutScoping(turn.deviceId, CHECKOUT_VIEW_NEEDS[view.mode]);
}

/** The turn frame's checkout fields: none for a writable checkout, which is what a box does unasked. */
export function checkoutFields(view: CheckoutView | null): Record<string, string | string[]> {
  if (!view) return {};
  if (view.mode === 'build' || view.mode === 'own') {
    return {
      checkout: view.mode,
      buildBase: view.base,
      buildKey: view.key,
      ...(view.mode === 'own' ? { ownHosts: view.hosts } : {}),
    };
  }
  return { checkout: view.mode };
}
