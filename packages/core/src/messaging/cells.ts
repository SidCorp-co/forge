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
  NO_DEVELOPER_DETAIL,
  NO_EMPTY_PROMISE,
  NO_OPTION_LINE,
  NO_REDACTED_SECRET,
  LEAD_HAS_TEXT,
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

  /**
   * The assistant's reply to somebody holding a role, in a Forge UI room.
   */
  // cm:guard this is `public:report` MINUS two rules and PLUS two, and each of the four is the difference between the two readers rather than a preference. Dropped: `no-developer-detail`, because its own comment reads "developer detail put to somebody who holds no role and cannot act on it" and this reader holds one — it refused a file path, a fenced block and a raw status word, which are three of the things a person opens the Forge UI to ask for, while the persona instructs the model to produce exactly those (ISS-1005). Dropped: `issue-references-exist`, for the reason `role:report` drops it. Added: `status-matches-the-row`, because a reader who CAN act on a merge claim is the reader a false one costs something; and `non-empty`, which `public:report` got from its own list.
  // cm:guard KEPT from `public:report`, and the reason each survived the move is that none of the three is about what the reader may be shown: `only-verified-citations` catches an id this project does not hold, which is an error wherever it is read; `no-empty-promise` catches a promise no later turn will keep, and a chat turn ends — that is the turn's lifecycle and not the reader's role; `progress-figures-match` checks figures against the snapshot THIS turn was shown, and `external-chat.ts` computes one unconditionally every turn. Dropping any of them was the regression ISS-1005's own review caught before it shipped.
  // cm:guard NOT folded into `role:report` by adding these rules there, and the reason is measured rather than tidy: `comments/screen.ts:screenAgentComment` gathers facts with no `progress`, and `progress-figures-match` fails CLOSED on a null snapshot — so adding it to that cell refuses every agent comment on the tracker. A cell of its own costs one row and reaches nothing else.
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
  // cm:guard these two rows ARE the lens. The only difference between them is `no-developer-detail`,
  // which is the one rule the issue makes the lens decide, and nothing under this directory branches
  // on an audience value to do it — a project that later wants a third reading is a third row
  // (ISS-1089). They are read by `record-screen.ts:screenLead` and by no door: the lead screen is a
  // SECOND `screenMessage` call at the `comment-write` door, and that door's cell stays `role:report`.
  cell(ROLE_PRODUCT, 'report', [LEAD_HAS_TEXT, NO_DEVELOPER_DETAIL]),

  /**
   * The same lead, where somebody who reads code is among the people reading it.
   */
  // cm:guard this cell is NOT empty and must not be emptied to "the lens that screens nothing": a
  // lead with no text says nothing was found whoever reads it, and dropping `lead-has-text` here
  // would admit a blank lead on exactly the projects whose readers would act on it.
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
