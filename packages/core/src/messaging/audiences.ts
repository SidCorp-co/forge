/**
 * Who reads a message. Two values ship; a third is a row rather than surgery,
 * which is the property ISS-997 exists to prove rather than assert.
 */

import type { Audience } from './contract.js';

export interface AudienceSpec {
  readonly id: Audience;
  /** Who this is, in the words somebody would use to describe the reader. */
  readonly reader: string;
}

/** Somebody holding a role on the project: they can open the tracker and check. */
export const ROLE_HOLDER: Audience = 'role';

/** Somebody who holds none: the tracker is not theirs to read. */
export const NO_ROLE: Audience = 'public';

/**
 * The same role holder, read through the lens their organization assigns them.
 */
// cm:guard these are AUDIENCES and not a flag on a rule, because the lens says who is reading and
// that is what an audience is. The id carries a colon on purpose: `doors.ts:cellPair` cuts a cell
// id at its LAST colon, and its own guard says it does so precisely because `Audience` is an open
// string nothing forbids one in — so `role:product:report` resolves to this audience and the
// `report` intent without a change to the carve (ISS-1089).
export const ROLE_PRODUCT: Audience = 'role:product';
export const ROLE_TECHNICAL: Audience = 'role:technical';

const SHIPPED: readonly AudienceSpec[] = [
  { id: ROLE_HOLDER, reader: 'somebody holding a role on the project' },
  { id: NO_ROLE, reader: 'somebody who holds no role on the project' },
  {
    id: ROLE_PRODUCT,
    reader: 'somebody holding a role, on a project no human member of which reads as technical',
  },
  {
    id: ROLE_TECHNICAL,
    reader: 'somebody holding a role, on a project at least one human member of which reads as technical',
  },
];

const registry = new Map<Audience, AudienceSpec>(SHIPPED.map((a) => [a.id, a]));

// cm:guard registration is the whole of adding an audience, and no code in `screen.ts` branches on an audience value — that is what makes a third one configuration. A `switch` on an id anywhere under this directory undoes it.
export function registerAudience(spec: AudienceSpec): void {
  registry.set(spec.id, spec);
}

export function audienceSpec(id: Audience): AudienceSpec | undefined {
  return registry.get(id);
}

export function registeredAudiences(): AudienceSpec[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test seam — resets to what ships, rather than to nothing. */
export function clearRegisteredAudiences(): void {
  registry.clear();
  for (const a of SHIPPED) registry.set(a.id, a);
}
