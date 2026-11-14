import { factsIn, type Linked } from './list-read.js';
import type { Row } from './read.js';
import { shippedFailingOf, shippedOwedOf } from './standing-carrier.js';

/** An item's own row, or its original's where it is a duplicate: the carriers it reads are those. */
const carrierRowOf = (r: Row, l: Linked): Row =>
  (r.route === 'duplicate' && r.duplicateOf ? l.roots.get(r.duplicateOf) : undefined) ?? r;

/** The criteria its carriers shipped failing (`ISS-18 c2`, ISS-1159); a duplicate reads its original's. */
export function shippedFailingIn(r: Row, l: Linked): string[] {
  return shippedFailingOf(factsIn(carrierRowOf(r, l), l));
}

/** The criteria its carriers shipped owed a live verdict (`ISS-382 c3`, ISS-1234); a duplicate reads its original's. */
export function shippedOwedIn(r: Row, l: Linked): string[] {
  return shippedOwedOf(factsIn(carrierRowOf(r, l), l));
}
