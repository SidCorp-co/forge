/**
 * The five situations, and the rules each is read against.
 *
 * A cell holds its rules and NOTHING else. How many times a message may be
 * repaired, and what happens when it cannot be, belong to the door — see
 * `doors.ts` for why (ISS-997).
 */

import { NO_ROLE, ROLE_HOLDER, ROLE_PRODUCT, ROLE_TECHNICAL } from './audiences.js';
import { ISSUE_REFERENCES_EXIST, STATUS_MATCHES_THE_ROW } from './claim-rules.js';
import { type Audience, type CellId, type CellSpec, cellId, type Intent } from './contract.js';
import { PROGRESS_FIGURES_MATCH } from './progress-rule.js';
import {
  COMMENT_HAS_TEXT,
  ISSUE_LINK_SHAPE,
  LEAD_HAS_TEXT,
  NO_DEVELOPER_DETAIL,
  NO_EMPTY_PROMISE,
  NO_OPTION_LINE,
  NO_REDACTED_SECRET,
  NO_ROOM_BROADCAST_ASK,
  NO_ROOM_BROADCAST_CARRIED,
  NON_EMPTY,
  ONLY_VERIFIED_CITATIONS,
  SINGLE_LINE,
} from './text-rules.js';

function cell(
  audience: Audience,
  intent: Intent,
  rules: CellSpec['rules'],
  reserved = false,
): CellSpec {
  return { id: cellId(audience, intent), audience, intent, rules, reserved };
}

const SHIPPED: readonly CellSpec[] = [
  /** A question put to somebody who can answer it. */
  cell(ROLE_HOLDER, 'ask', [
    NON_EMPTY,
    NO_ROOM_BROADCAST_ASK,
    SINGLE_LINE,
    NO_OPTION_LINE,
    NO_REDACTED_SECRET,
  ]),

  /** A comment on an issue, read by the person who decides. */
  cell(ROLE_HOLDER, 'report', [
    COMMENT_HAS_TEXT,
    STATUS_MATCHES_THE_ROW,
    NO_ROOM_BROADCAST_CARRIED,
    NO_REDACTED_SECRET,
  ]),

  cell(
    NO_ROLE,
    'ask',
    [
      NON_EMPTY,
      NO_ROOM_BROADCAST_ASK,
      NO_DEVELOPER_DETAIL,
      ONLY_VERIFIED_CITATIONS,
      NO_REDACTED_SECRET,
    ],
    true,
  ),

  /**
   * The assistant's reply to somebody holding a role, in a Forge UI room.
   */
  cell(ROLE_HOLDER, 'chat', [
    NON_EMPTY,
    STATUS_MATCHES_THE_ROW,
    ONLY_VERIFIED_CITATIONS,
    ISSUE_LINK_SHAPE,
    NO_EMPTY_PROMISE,
    PROGRESS_FIGURES_MATCH,
    NO_REDACTED_SECRET,
  ]),

  /**
   * A record's `lead`, on a project whose human members all read as product.
   */
  cell(ROLE_PRODUCT, 'report', [LEAD_HAS_TEXT, NO_DEVELOPER_DETAIL]),

  /**
   * The same lead, where somebody who reads code is among the people reading it.
   */
  cell(ROLE_TECHNICAL, 'report', [LEAD_HAS_TEXT]),

  /** A reply to somebody with no role, who cannot open the tracker to check it. */
  cell(NO_ROLE, 'report', [
    ISSUE_REFERENCES_EXIST,
    NO_DEVELOPER_DETAIL,
    ONLY_VERIFIED_CITATIONS,
    ISSUE_LINK_SHAPE,
    NO_EMPTY_PROMISE,
    PROGRESS_FIGURES_MATCH,
  ]),
];

const registry = new Map<CellId, CellSpec>(SHIPPED.map((c) => [c.id, c]));

/** How a third audience arrives: its cells are rows, not a branch in the screen. */
export function registerCell(spec: CellSpec): void {
  registry.set(spec.id, spec);
}

export function cellFor(audience: Audience, intent: Intent): CellSpec | undefined {
  return registry.get(cellId(audience, intent));
}

export function registeredCells(): CellSpec[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test seam — resets to what ships, rather than to nothing. */
export function clearRegisteredCells(): void {
  registry.clear();
  for (const c of SHIPPED) registry.set(c.id, c);
}
