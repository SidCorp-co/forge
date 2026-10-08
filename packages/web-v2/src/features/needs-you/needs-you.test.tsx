// What waits on the viewer, drawn from core's one needs-you read (ISS-75, dev.54): the inbox groups
// its rows by area in the fixed area order, each row opens what it names (an issue in the list's
// peek), and the menu's hint names the acts behind a count.

import { verbatim } from "@forge/contracts/said";
import { RULE, say, waitingOn } from "@/test/said";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { NeedsYouList } from "./components/needs-you-list";
import { needsYouHint } from "./hint";
import { needsYouHref, needsYouPeekHref } from "./routes";
import type { NeedsYouItem } from "./types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => {
  const title = over.title ?? "Answer the agent's question";
  return {
    area: "issues",
    space: "asks",
    entity: "issue",
    key: "ISS-7",
    title,
    titleLang: null,
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("issues.standing.act.answer"), rule: RULE }),
    touchedAt: null,
    says: { title: verbatim(title) },
    ...over,
  };
};

describe("the needs-you inbox", () => {
  it("groups its rows by area, in the fixed area order, and drops an empty area", () => {
    render(
      <NeedsYouList
        slug="hop"
        foldKey="t1"
        empty="Nothing waits on you."
        items={[
          item({}),
          item({ area: "requirements", entity: "requirement", key: "REQ-2", title: "Agree the checkout" }),
          item({ area: "feedback", entity: "feedback", key: "FB-9", title: "Triage the crash" }),
        ]}
      />,
    );
    const keys = screen.getAllByTestId("list-row").map((r) => r.getAttribute("data-key"));
    expect(keys).toEqual(["requirement:REQ-2", "feedback:FB-9", "issue:ISS-7"]);
    expect(screen.queryByText("Releases")).toBeNull();
  });

  it("draws each row's waiting-on from core, and opens an issue in the list's peek", () => {
    push.mockReset();
    render(<NeedsYouList slug="hop" foldKey="t2" empty="" items={[item({})]} />);
    const row = screen.getByTestId("list-row");
    expect(within(row).getByTestId("waiting-on")).toHaveTextContent("You · answer a question");
    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith("/projects/hop/issues?peek=ISS-7");
  });

  it("says under a row what doing its act changes, where core gave one", () => {
    const w = waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.splitRelease"), rule: RULE, effect: say("releases.effect.split", { limit: 50, left: say("releases.effect.splitOthers") }) });
    render(<NeedsYouList slug="hop" foldKey="t2b" empty="" items={[item({ area: "releases", entity: "release", key: "0.1.0", waitingOn: w })]} />);
    expect(within(screen.getByTestId("list-row")).getByTestId("row-note")).toHaveTextContent("Cuts the oldest 50 merged issues as this release and leaves the others at the release gate for the next one.");
  });

  it("words a row core says itself in the reader's language: one row for a base's pin-only dependents", () => {
    const title = say("designs.title.repinBatch", { n: 6, designs: "designs", need: "need", its: "their", r: 13 });
    const w = waitingOn("you", { who: say("standing.who.you"), act: say("designs.act.repinBatch", { n: 6, changes: "changes", r: 13 }), rule: RULE });
    render(
      <InterfaceLanguageScope language="vi">
        <NeedsYouList slug="hop" foldKey="t2c" empty="" items={[item({ area: "designs", entity: "workflow", key: "access", title: "6 designs only need their pin moved → r13", says: { title }, waitingOn: w })]} />
      </InterfaceLanguageScope>,
    );
    const row = screen.getByTestId("list-row");
    expect(row).toHaveTextContent("6 thiết kế chỉ cần đổi ghim → r13"); // i18n-allow: asserts the vi copy of the re-pin act
    expect(within(row).getByTestId("waiting-on")).toHaveTextContent("duyệt 6 bản chỉ đổi ghim → r13"); // i18n-allow: asserts the vi copy of the re-pin act
  });

  it("says so when nothing waits on the viewer", () => {
    render(<NeedsYouList slug="hop" foldKey="t3" empty="Nothing waits on you." items={[]} />);
    expect(screen.getByText("Nothing waits on you.")).toBeInTheDocument();
  });
});

describe("where a needs-you row leads", () => {
  it("opens a question attached to nothing on the Questions tab, focused on that question", () => {
    const q = { entity: "question", key: "b2dccb6a-1111-4222-8333-444455556666" } as const;
    expect(needsYouHref("hop", q)).toBe("/projects/hop/agents?tab=questions&q=b2dccb6a-1111-4222-8333-444455556666");
    expect(needsYouPeekHref("hop", q)).toBe(needsYouHref("hop", q));
  });

  it("draws a question row under Questions, keyed by the area and not by its id", () => {
    render(
      <NeedsYouList
        slug="hop"
        foldKey="t2"
        empty="Nothing waits on you."
        items={[item({ area: "questions", entity: "question", key: "b2dccb6a-1111-4222-8333-444455556666", title: "Which roles does the catalogue hold?" })]}
      />,
    );
    const row = screen.getByTestId("list-row");
    expect(within(row).getByText("Which roles does the catalogue hold?")).toBeTruthy();
    expect(within(row).queryByText("b2dccb6a-1111-4222-8333-444455556666")).toBeNull();
    fireEvent.click(row);
    expect(push).toHaveBeenLastCalledWith("/projects/hop/agents?tab=questions&q=b2dccb6a-1111-4222-8333-444455556666");
  });

  it("opens its own page for everything but an issue", () => {
    expect(needsYouHref("hop", { entity: "requirement", key: "REQ-2" })).toBe("/projects/hop/requirements/REQ-2");
    expect(needsYouPeekHref("hop", { entity: "feedback", key: "FB-9" })).toBe(needsYouHref("hop", { entity: "feedback", key: "FB-9" }));
    expect(needsYouHref("hop", { entity: "workflow", key: "shell", waitingOn: { kind: "you" } })).toBe("/projects/hop/workflows/shell?tab=revisions");
    expect(needsYouHref("hop", { entity: "workflow", key: "shell", waitingOn: { kind: "person" } })).toBe("/projects/hop/workflows/shell");
    expect(needsYouPeekHref("hop", { entity: "issue", key: "ISS-7" })).toBe("/projects/hop/issues?peek=ISS-7");
  });
});

describe("the menu's hint", () => {
  it("names the acts behind the count, counting repeats", () => {
    expect(
      needsYouHint("Issues", {
        you: 3,
        acts: [
          { act: "answer a question", count: 2, says: { act: say("issues.standing.act.answer") } },
          { act: "", count: 1, says: { act: say("standing.act.none") } },
        ],
      }),
    ).toBe("Issues · waiting on you 3: answer a question (2), act");
  });

  it("says nothing waits when the count is nought", () => {
    expect(needsYouHint("Releases", { you: 0, acts: [] })).toBe("Releases · nothing waits on you");
  });
});
