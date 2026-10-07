// What waits on the viewer, drawn from core's one needs-you read (ISS-75, dev.54): the inbox groups
// its rows by area in the fixed area order, each row opens what it names (an issue in the list's
// peek), and the menu's hint names the acts behind a count.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NeedsYouList } from "./components/needs-you-list";
import { needsYouHint } from "./hint";
import { needsYouHref, needsYouPeekHref } from "./routes";
import type { NeedsYouItem } from "./types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  area: "issues",
  entity: "issue",
  key: "ISS-7",
  title: "Answer the agent's question",
  waitingOn: { kind: "you", who: "You", act: "answer it", rule: "a question waits on its asker", ref: null, dueAt: null },
  touchedAt: null,
  ...over,
});

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
    expect(within(row).getByTestId("waiting-on")).toHaveTextContent("You · answer it");
    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith("/projects/hop/issues?peek=ISS-7");
  });

  it("says under a row what doing its act changes, where core gave one", () => {
    const w = { kind: "you" as const, who: "You", act: "split this release into smaller releases", rule: "r", effect: "Cuts the oldest 50 merged issues as this release.", ref: null, dueAt: null };
    render(<NeedsYouList slug="hop" foldKey="t2b" empty="" items={[item({ area: "releases", entity: "release", key: "0.1.0", waitingOn: w })]} />);
    expect(within(screen.getByTestId("list-row")).getByTestId("row-note")).toHaveTextContent("Cuts the oldest 50 merged issues as this release.");
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
          { act: "answer it", count: 2 },
          { act: "", count: 1 },
        ],
      }),
    ).toBe("Issues · waiting on you 3: answer it (2), act");
  });

  it("says nothing waits when the count is nought", () => {
    expect(needsYouHint("Releases", { you: 0, acts: [] })).toBe("Releases · nothing waits on you");
  });
});
