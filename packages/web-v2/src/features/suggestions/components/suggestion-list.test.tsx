// ISS-278 / FB-90: on HOP REQ-31 a breakdown's "Show details" listed three issue titles and nothing
// else, so a slice's scope could only be learned after accepting it. The details now show each slice
// as core reads it: description, criteria by BC code, the design revision it builds, what it waits on.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    expect(first).toHaveTextContent("After ISS-12 · Tour shell (Open)");
    expect(second).toHaveTextContent("After slice 1 · Tour player");
    expect(second).toHaveTextContent("Accept would refuse ISS-9: blockedBy entry ISS-9 is dropped");
  });

  it("says when a breakdown arrives without core's reading, rather than falling back to its titles", async () => {
    shown(breakdown({ breakdown: undefined }));
    const panel = await details();
    expect(panel).toHaveTextContent("Core sent no reading of this breakdown's slices.");
    expect(panel).not.toHaveTextContent("Tour player");
  });

});

// ISS-281 / FB-16: Accept applied at once with no field for why or on whose authority, while Reject
// required a reason; accepting a breakdown files issues. Accept now opens a confirm step that sends
// the reason the API takes (ISS-84).
describe("Accept on a waiting suggestion", () => {
  function listed(reply: (path: string, body: unknown) => { status?: number; body: unknown } | undefined = () => undefined) {
    const calls = fakeCore((c) => (c.method === "GET" ? { body: { suggestions: [breakdown()], open: 1 } } : reply(c.path, c.body)));
    renderWithQuery(<RequirementSuggestions projectId="p1" reqKey="REQ-31" />);
    return calls;
  }
  const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST");

  it("opens a confirm step naming what accepting does, and sends nothing until it is confirmed", async () => {
    const calls = listed();
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const step = screen.getByTestId("accept-step");
    expect(step).toHaveTextContent("Accepting files 2 issues at draft against r2.");
    expect(within(step).getByRole("textbox", { name: "Why it is accepted, and on whose authority" })).toBeInTheDocument();
    expect(posts(calls)).toEqual([]);
    fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("accept-step")).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it("sends the typed reason with the accept", async () => {
    const calls = listed(() => ({ body: { suggestion: { ...breakdown(), status: "accepted" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const step = screen.getByTestId("accept-step");
    fireEvent.change(within(step).getByRole("textbox"), { target: { value: "  Owner signed this off in the REQ-31 review  " } });
    fireEvent.click(within(step).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(posts(calls)).toEqual([
        { method: "POST", path: "/projects/p1/suggestions/s1/accept", body: { reason: "Owner signed this off in the REQ-31 review" } },
      ]),
    );
  });

  it("accepts with no reason when the field is left empty, as the API allows", async () => {
    const calls = listed(() => ({ body: { suggestion: { ...breakdown(), status: "accepted" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/suggestions/s1/accept", body: {} }]));
  });
});

describe("a breakdown's details, read as a person", () => {
  it("names a blocker's status in words, not its raw value", async () => {
    const view = breakdown();
    const read = view.breakdown;
    if (!read) throw new Error("fixture carries a read");
    read.slices[0] = { ...read.slices[0], blockedBy: [{ issue: "ISS-12", title: "Tour shell", status: "in_progress" }] } as (typeof read.slices)[number];
    shown(view);
    const [first] = within(await details()).getAllByTestId("breakdown-slice");
    expect(first).toHaveTextContent("After ISS-12 · Tour shell (In progress)");
  });

  it("says in plain words that an unreadable breakdown cannot be accepted as stored, keeping the code and path", async () => {
    shown(breakdown({ breakdown: { revision: 2, unreadable: "SUGGESTION_PAYLOAD_INVALID at /payload/issues/0/criteria: required", uncovered: [], slices: [] } }));
    const panel = await details();
    expect(panel).toHaveTextContent("This breakdown can no longer be read, so it cannot be accepted as it is stored.");
    expect(panel).not.toHaveTextContent("Core could not read");
    expect(panel).toHaveTextContent("SUGGESTION_PAYLOAD_INVALID at /payload/issues/0/criteria: required");
  });
});
