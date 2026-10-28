// How a confined turn shows its session the project's checkout (REQ-75 r5 BC-27): read-only, not at
// all, or as the room's own writable working copy of the development branch. The view is on the turn
// frame, and only a box that declares it can scope a checkout is handed one: an older runner ignores
// the field and would mount the checkout writable, which is what the room was not granted.

import { requireCheckoutScoping } from './chat-device.js';

/**
 * A room's view of the checkout: read-only, none (an empty folder), or a writable working copy of
 * `base` the box keeps under `key` for a room granted build.
 */
export type CheckoutView =
  | { mode: 'read' }
  | { mode: 'none' }
  | { mode: 'build'; base: string; key: string };

/** The box capabilities a checkout view needs (`@forge/contracts/support:SUPPORT_BOX_CAPABILITIES`). */
const CHECKOUT_VIEW_NEEDS: Record<CheckoutView['mode'], readonly string[]> = {
  read: ['chatCheckoutModes'],
  none: ['chatCheckoutModes'],
  build: ['chatCheckoutModes', 'supportBuilds'],
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
export function checkoutFields(view: CheckoutView | null): Record<string, string> {
  if (!view) return {};
  if (view.mode === 'build') {
    return { checkout: 'build', buildBase: view.base, buildKey: view.key };
  }
  return { checkout: view.mode };
}
