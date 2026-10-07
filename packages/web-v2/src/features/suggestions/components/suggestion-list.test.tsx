// ISS-278 / FB-90: on HOP REQ-31 a breakdown's "Show details" listed three issue titles and nothing
// else, so a slice's scope could only be learned after accepting it. The details now show each slice
// as core reads it: description, criteria by BC code, the design revision it builds, what it waits on.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { SuggestionView } from "../types";
import { RequirementSuggestions } from "./suggestion-list";

afterEach(() => vi.unstubAllGlobals());

const breakdown = (over: Partial<SuggestionView> = {}): SuggestionView =>
  ({
    id: "s1",
    kind: "breakdown",
    status: "proposed",
    target: { type: "requirement", id: "r1" },
    baseRevision: 2,
    payload: { issues: [{ title: "Tour player" }, { title: "Tour content and stats" }] },
    producerKind: "agent",
    model: null,
    createdAt: "2026-10-06T17:00:00.000Z",
    breakdown: {
      revision: 2,
      unreadable: null,
      uncovered: [{ code: "BC-4", reason: "waits on tour.manage" }],
      slices: [
        {
          title: "Tour player",
          description: "Plays the tour the design draws; content ships with the build.",
          complexity: "m",
          criteria: [{ code: "BC-1", body: "a first visit starts the tour" }],
          builds: { flow: "hop-product-tour", designRevision: 2 },
          buildsRefusal: null,
          blockedBy: [{ issue: "ISS-12", title: "Tour shell", status: "open" }],
        },
        {
          title: "Tour content and stats",
          description: null,
          complexity: "s",
          criteria: [
            { code: "BC-2", body: "completion is counted" },
            { code: "BC-3", body: "a missing step is reported" },
          ],
          builds: null,
          buildsRefusal: null,
          blockedBy: [
            { slice: 0, title: "Tour player" },
            { ref: "ISS-9", code: "SUGGESTION_BLOCKER_TERMINAL", refusal: "blockedBy entry ISS-9 is dropped" },
          ],
        },
      ],
    },
    ...over,
  }) as SuggestionView;

function shown(view: SuggestionView) {
  fakeCore(() => ({ body: { suggestions: [view], open: 1 } }));
  renderWithQuery(<RequirementSuggestions projectId="p1" reqKey="REQ-31" />);
}

async function details() {
  fireEvent.click(await screen.findByText("Show details"));
  return screen.getByTestId("breakdown-slices");
}

describe("a breakdown's details, before Accept", () => {
  it("numbers each slice with its title, complexity and description", async () => {
    shown(breakdown());
    const slices = within(await details()).getAllByTestId("breakdown-slice");
    expect(slices).toHaveLength(2);
    expect(slices[0]).toHaveTextContent("1. Tour player");
    expect(slices[0]).toHaveTextContent("complexity m");
    expect(slices[0]).toHaveTextContent("Plays the tour the design draws; content ships with the build.");
    expect(slices[1]).toHaveTextContent("2. Tour content and stats");
    expect(slices[1]).toHaveTextContent("No description");
  });

  it("lists each slice's criteria by the BC code it traces to, and what the breakdown leaves uncovered", async () => {
    shown(breakdown());
    const panel = await details();
    const [, second] = within(panel).getAllByTestId("breakdown-slice");
    expect(within(second as HTMLElement).getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      expect.arrayContaining(["BC-2 · completion is counted", "BC-3 · a missing step is reported"]),
    );
    expect(panel).toHaveTextContent("Leaves uncovered: BC-4 · waits on tour.manage");
  });

  it("names the design revision each slice builds, or that it builds none", async () => {
    shown(breakdown());
    const [first, second] = within(await details()).getAllByTestId("breakdown-slice");
    expect(first).toHaveTextContent("Builds hop-product-tour r2");
    expect(second).toHaveTextContent("Builds no design");
  });

  it("shows the refusal where the accept would refuse a slice's design", async () => {
    const view = breakdown();
    const read = view.breakdown;
    if (!read) throw new Error("fixture carries a read");
    read.slices[1] = { ...read.slices[1], buildsRefusal: "print-flow is not a design the requirement's latest baseline pins" } as (typeof read.slices)[number];
    shown(view);
    const [, second] = within(await details()).getAllByTestId("breakdown-slice");
    expect(second).toHaveTextContent("Accept would refuse its design: print-flow is not a design the requirement's latest baseline pins");
  });

  it("names what each slice waits on: another slice, an existing issue, or the refusal", async () => {
    shown(breakdown());
    const [first, second] = within(await details()).getAllByTestId("breakdown-slice");
    expect(first).toHaveTextContent("After ISS-12 · Tour shell (open)");
    expect(second).toHaveTextContent("After slice 1 · Tour player");
    expect(second).toHaveTextContent("Accept would refuse ISS-9: blockedBy entry ISS-9 is dropped");
  });

  it("says when a breakdown arrives without core's reading, rather than falling back to its titles", async () => {
    shown(breakdown({ breakdown: undefined }));
    const panel = await details();
    expect(panel).toHaveTextContent("Core sent no reading of this breakdown's slices.");
    expect(panel).not.toHaveTextContent("Tour player");
  });

  it("says a stored breakdown core could not read, rather than showing its titles as if whole", async () => {
    shown(breakdown({ breakdown: { revision: 2, unreadable: "SUGGESTION_PAYLOAD_INVALID at /payload/issues/0/criteria: required", uncovered: [], slices: [] } }));
    expect(await details()).toHaveTextContent("Core could not read this breakdown: SUGGESTION_PAYLOAD_INVALID at /payload/issues/0/criteria: required");
  });
});
