// REQ-12 (one set of conventions): each card's confirm step is its own. Reported on forge-dev
// 2026-10-08 from REQ-32 (a revision and a breakdown card) as "Accept on one opens the confirm row on
// every card"; it did not reproduce, here or on dev.191 with three cards. The report came from a
// script that pressed the page's last button named Accept after opening the first card's step, and
// that is the next card's opener, since a card's confirm and its opener share the name. This holds
// the per-card state where lifting it to the list (the shape the report describes) goes red.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { SuggestionView } from "../types";
import { RequirementSuggestions } from "./suggestion-list";

afterEach(() => vi.unstubAllGlobals());

const base = {
  status: "proposed",
  target: { type: "requirement", id: "r1" },
  baseRevision: 1,
  producerKind: "agent",
  model: null,
  createdAt: "2026-10-08T13:43:03.000Z",
} as const;
const revision = {
  ...base,
  id: "c7ab256a",
  kind: "revision_diff",
  payload: { reason: "add the progress analysis", criteria: [{ code: "BC-1", body: "it holds" }, { body: "a new one" }] },
} as unknown as SuggestionView;
const breakdown = {
  ...base,
  id: "b1",
  kind: "breakdown",
  payload: { issues: [{ title: "Report analysis" }] },
  breakdown: { revision: 1, unreadable: null, uncovered: [], slices: [] },
} as unknown as SuggestionView;

async function cards() {
  fakeCore(() => ({ body: { suggestions: [revision, breakdown], open: 2 } }));
  renderWithQuery(<RequirementSuggestions projectId="p1" reqKey="REQ-32" />);
  const rows = await screen.findAllByTestId("requirement-suggestion");
  expect(rows).toHaveLength(2);
  return rows as [HTMLElement, HTMLElement];
}

const accept = (card: HTMLElement) => within(card).getByRole("button", { name: "Accept" });
const reject = (card: HTMLElement) => within(card).getByRole("button", { name: "Reject" });

describe("two suggestions waiting on the person", () => {
  it("opens the confirm step on the card whose Accept was pressed, and on no other", async () => {
    const [first, second] = await cards();
    fireEvent.click(accept(first));
    expect(within(first).getByTestId("accept-step")).toBeInTheDocument();
    expect(within(second).queryByTestId("accept-step")).toBeNull();
    expect(screen.getAllByTestId("accept-step")).toHaveLength(1);
    expect(accept(second)).toBeEnabled();
    expect(accept(second)).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps each card's step its own: the second opens beside the first, and Cancel closes only its own", async () => {
    const [first, second] = await cards();
    fireEvent.click(accept(second));
    expect(within(second).getByTestId("accept-step")).toBeInTheDocument();
    expect(within(first).queryByTestId("accept-step")).toBeNull();
    fireEvent.click(reject(first));
    expect(within(first).getByRole("textbox", { name: /why/i })).toBeInTheDocument();
    fireEvent.click(within(second).getByRole("button", { name: "Cancel" }));
    expect(within(second).queryByTestId("accept-step")).toBeNull();
    expect(within(first).getByRole("textbox", { name: /why/i })).toBeInTheDocument();
  });
});
