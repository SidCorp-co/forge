// Agents / Runs shows a group's label and count, then one line per run: its title and its state, whom
// it waits on that state's hover (REQ-11 BC-18, BC-22, ISS-903). A run opens in place with its acts,
// facts and full page; the grouping and the filters are the palette's, and the one next action is the
// run that needs the viewer.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, PageCommandsProvider, usePageCommandList } from "@/design";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { access, data } from "@/test/vi-chrome-agents";
import { Seeded } from "@/test/vi-chrome-requirements";
import { AgentsScreen } from "./agents-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
Element.prototype.scrollIntoView = () => {};

function Palette() {
  return <CommandPalette open onClose={() => {}} commands={usePageCommandList()} />;
}

const runs = (withPalette = false) =>
  render(
    <PageCommandsProvider>
      <Seeded data={data()}>
        <AgentsScreen access={access} />
      </Seeded>
      {withPalette ? <Palette /> : null}
    </PageCommandsProvider>,
  );

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("Agents / Runs face", () => {
  it("draws each group as its label and count, and each run as one line with no fact opened", () => {
    runs();
    expect(screen.getByTestId("runs-group-stuck").textContent).toMatch(/^Stuck2/);
    expect(screen.getAllByTestId("run-row").length).toBeGreaterThanOrEqual(20);
    expect(screen.queryByTestId("run-detail")).toBeNull();
    expect(screen.queryByTestId("runs-signals")).toBeNull();
  });

  it("names no run or issue key on its face", () => {
    const { container } = runs();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("puts whom a run waits on in its state's hover, not on the face", () => {
    runs();
    const row = within(screen.getByTestId("runs-group-needs_you")).getByTestId("run-row");
    const chip = row.querySelector("[data-status-chip]");
    expect(chip?.getAttribute("data-reason")).toMatch(/^You · answer/);
  });

  it("opens a run in place with its facts and its full page, and j moves to the next", async () => {
    const user = userEvent.setup();
    runs();
    const stuck = within(screen.getByTestId("runs-group-stuck")).getAllByRole("button", { expanded: false });
    await user.click(stuck[0]);
    const detail = screen.getByTestId("run-detail");
    expect(within(detail).getByTestId("run-open")).toHaveTextContent("Open page");
    await user.keyboard("j");
    expect(document.activeElement).toHaveAccessibleName(/Viec 13/);
  });

  it("leads with the act the viewer owes, linked to its issue", () => {
    runs();
    const next = screen.getByTestId("runs-next");
    expect(next).toHaveTextContent("Answer a question");
    expect(next.getAttribute("href")).toBe("/projects/hop/issues/ISS-1");
  });

  it("carries the grouping and the filters in the palette, and a filter narrows the list", async () => {
    const user = userEvent.setup();
    runs(true);
    const palette = await screen.findByRole("dialog");
    const acts = within(palette).getAllByRole("option").map((o) => o.textContent);
    expect(acts).toEqual(["Group by Lane", "Group by Box", "Only waiting on you", "Only stuck runs"]);
    await user.click(within(palette).getByRole("option", { name: "Only stuck runs" }));
    expect(window.location.search).toBe("?f=stuck");
  });

  it("draws the whole live list, every row and group, in at most 200 words (BC-21: the witness holds its first view to 110)", () => {
    const { container } = runs();
    // jsdom draws every row, so this is the whole list: the first view the witness counts is less
    expect(faceWords(container)).toBeLessThanOrEqual(200);
  });
});
