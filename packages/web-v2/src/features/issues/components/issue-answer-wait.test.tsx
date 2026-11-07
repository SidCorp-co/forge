// ISS-687 round 2 (REQ-68 BC-4, BC-6): judge run 6c6e24b4 at dev.485 read four needs_info rows on the
// Issues list as "orchestrator, qa · answer a question", with a person's mark, and ISS-643's page as
// waiting on them to answer. An issue whose question a person owes waits on the answer: the row, the
// page's Now line and its Stuck banner say that alone, with no person's mark, name or act, in either
// language; the question is asked in Needs you, on the item it is about. Planted red by drawing the
// `answer` kind with a person's mark (`WAITING_KIND_MARKS`) and by core's old wait on the writers.
//
// @direct-test-of packages/web-v2/src/features/issues/components/issue-standing-bits.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/detail/issue-state-head.tsx
// @direct-test-of packages/web-v2/src/features/issues/components/waiting-on-person-chip.tsx
// @direct-test-of packages/web-v2/src/design/patterns/waiting-on.tsx

import type { IssueStanding } from "@forge/contracts/issue-standing";
import { say } from "@forge/contracts/said";
import { waitingOn } from "@forge/contracts/standing";
import type { ReactElement } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WaitingOn } from "@/design/patterns/waiting-on";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { renderWithQuery } from "@/test/render";
import { IssueStateHead } from "./detail/issue-state-head";
import { IssueStuckBanner } from "./issue-standing-bits";
import { WaitingOnPersonChip } from "./waiting-on-person-chip";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

/** What core's issue standing says of a park a person owes (`issues/standing.ts:answerTurn`). */
const owed = (who: "answer" | "decision" | "supply") =>
  waitingOn("answer", {
    who: say(`issues.standing.who.${who}`),
    act: say("standing.act.none"),
    rule: say("issues.rule.needsInfo"),
  });

const standing = (w: ReturnType<typeof owed>, stuck: boolean) =>
  ({
    state: "needs_info",
    step: null,
    attentionGroup: stuck ? "stuck" : "queued",
    tone: "waiting",
    waitingOn: w,
    releaseHold: null,
    times: {
      actClass: "person_decide",
      since: "2026-10-23T00:00:00.000Z",
      dueAt: "2026-10-28T00:00:00.000Z",
      stuck: stuck
        ? {
            code: "overdue",
            since: "2026-10-28T00:00:00.000Z",
            reason: "An answer was due by 2026-10-28.",
            via: null,
            says: { reason: say("standing.stuck.answerOverdue", { what: w.says.who, date: "2026-10-28" }) },
          }
        : null,
      carriedBy: null,
      basis: "b",
    },
  }) as unknown as IssueStanding;

/** Words that would ask a person to act on the issue, or name who must, in English. */
const ACT_KEYS: ProductCopyKey[] = ["issues.standing.act.answer", "issues.standing.act.decide", "issues.standing.act.supply"];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PERSON_ACT = new RegExp(
  ["answer a question", "make a decision", "supply what it asks", "must answer", "orchestrator", ...ACT_KEYS.map((k) => productCopy("en")(k))].map(escape).join("|"),
  "i",
);

function draw(node: ReactElement) {
  return renderWithQuery(node);
}

describe("an issue that waits on a person's answer names no person and no act (ISS-687)", () => {
  const t = productCopy("en");
  const answer = t("issues.standing.who.answer");

  it(`its list row draws the answer as plain text, with no person's mark`, () => {
    draw(<WaitingOn w={owed("answer")} />);
    const cell = screen.getByTestId("waiting-on");
    expect(cell).toHaveAttribute("data-kind", "none");
    expect(cell.textContent).toBe(answer);
    expect(cell.textContent).not.toMatch(PERSON_ACT);
    expect(cell.textContent).not.toContain("⟦");
  });

  it(`its page's Now line says what it waits on and nothing a person does`, () => {
    draw(<IssueStateHead standing={standing(owed("answer"), false)} forecast={undefined} />);
    const now = screen.getByTestId("issue-now");
    expect(now).toHaveTextContent(answer);
    expect(now.textContent).not.toMatch(PERSON_ACT);
    expect(now.textContent).not.toContain("·");
  });

  it(`its Stuck banner says the answer is overdue, never who must give it`, () => {
    draw(<IssueStuckBanner standing={standing(owed("answer"), true)} />);
    const banner = screen.getByTestId("issue-stuck-banner");
    expect(screen.getByTestId("wait-effect")).toHaveTextContent(answer);
    expect(banner.textContent).not.toMatch(PERSON_ACT);
    expect(banner.textContent).not.toContain("⟦");
  });

  it.each([
    ["decision", "A decision"],
    ["supply", "Something supplied"],
  ] as const)("a park on a %s reads %s, with no act", (kind, words) => {
    draw(<WaitingOn w={owed(kind)} />);
    expect(screen.getByTestId("waiting-on").textContent).toBe(words);
  });

  it("its row's age chip says it waits on an answer, never on a person", () => {
    draw(<WaitingOnPersonChip since="2026-11-01T00:00:00.000Z" now={Date.parse("2026-11-04T00:00:00.000Z")} />);
    const chip = screen.getByTestId("waiting-on-person");
    expect(chip).toHaveTextContent(/^Waits on an answer · /);
    expect(chip.textContent).not.toMatch(/person/i);
  });
});
