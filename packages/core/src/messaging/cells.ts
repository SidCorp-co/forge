/**
 * The four situations, and the rules each is read against.
 *
 * A cell holds its rules and NOTHING else. How many times a message may be
 * repaired, and what happens when it cannot be, belong to the door — see
 * `doors.ts` for why (ISS-997).
 */

import { NO_ROLE, ROLE_HOLDER } from './audiences.js';
import { ISSUE_REFERENCES_EXIST, STATUS_MATCHES_THE_ROW } from './claim-rules.js';
import { type Audience, type CellId, type CellSpec, cellId, type Intent } from './contract.js';
import { PROGRESS_FIGURES_MATCH } from './progress-rule.js';
import {
  COMMENT_HAS_TEXT,
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

// cm:guard rule ORDER inside a cell is load-bearing and not cosmetic: `legacy-verdicts.fixture.json` froze the order the old composed screens produced their problems in, and the differential test compares the lists rather than the sets. Reordering a cell reds it by name.
const SHIPPED: readonly CellSpec[] = [
  /** A question put to somebody who can answer it. */
  cell(ROLE_HOLDER, 'ask', [
    NON_EMPTY,
    NO_ROOM_BROADCAST_ASK,
    SINGLE_LINE,
    NO_OPTION_LINE,
    NO_REDACTED_SECRET,
  ]),

  /**
   * A report to somebody holding a role on the project — read at two doors.
   */
  // cm:guard it covers a comment on an issue AND an assistant's reply in a Forge UI room, and the description says both because it used to say only the first: ISS-1005 moved the browser onto this cell and a reader checking whether a rule belonged would have measured it against comments alone. All four rules below are true of both messages, which is why this is one cell read at two doors rather than two cells carrying a copy of the same list — the duplication the cell/door split exists to prevent. What differs between the two is the ENDING, and that lives on the door.
  /** A comment on an issue, read by the person who decides. */
  // cm:guard `issue-references-exist` is deliberately NOT here, and the reason is measured rather than assumed: in an 18-issue sample of this project's own comments, 6 of 391 cite a `forge-plugin` key — which CLAUDE.md's own carve-out REQUIRES an agent to do when it finds a defect in that repo. An existence rule here would refuse the mandated behaviour once every 66 comments. A reference this project does not hold is very likely another project's, so it is not judged; a status ASSERTED of an issue this project does hold still is.
  cell(ROLE_HOLDER, 'report', [
    COMMENT_HAS_TEXT,
    STATUS_MATCHES_THE_ROW,
    NO_ROOM_BROADCAST_CARRIED,
    NO_REDACTED_SECRET,
  ]),

  // cm:guard reserved, and NOT foldable into `public:report`: the product has no door where an agent declares an ask to a reader holding no role, and reading one against `no-empty-promise` would refuse the single message that reader is there to answer. The shortfall is named in ISS-997 itself and priced in docs/proposals/.
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

  /** A reply to somebody with no role, who cannot open the tracker to check it. */
  cell(NO_ROLE, 'report', [
    ISSUE_REFERENCES_EXIST,
    NO_DEVELOPER_DETAIL,
    ONLY_VERIFIED_CITATIONS,
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
