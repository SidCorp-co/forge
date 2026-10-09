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

  // ISS-281's judge: a refused wait on another slice read "Accept would refuse 0: …" beside "After slice 1",
  // the payload's 0-based index next to the list's 1-based numbers
  it("words a refused wait on another slice with the slice numbers the list shows", async () => {
    const [player, stats] = breakdown().breakdown?.slices ?? [];
    const self = { ref: "0", code: "SUGGESTION_PAYLOAD_INVALID", refusal: "blockedBy names issue index 0, which is this issue itself." };
    const outside = { ref: "5", code: "SUGGESTION_PAYLOAD_INVALID", refusal: "blockedBy names issue index 5, which is outside the 2 proposed issues." };
    const loop = { ref: "0", code: "SUGGESTION_PAYLOAD_INVALID", refusal: "the blockedBy edges among the proposed issues form a cycle, so none of them could ever start." };
    shown(
      breakdown({
        breakdown: {
          revision: 2,
          unreadable: null,
          uncovered: [],
          slices: [
            { ...(player as NonNullable<typeof player>), blockedBy: [self] },
            { ...(stats as NonNullable<typeof stats>), blockedBy: [outside, loop] },
          ],
        },
      }),
    );
    const [first, second] = within(await details()).getAllByTestId("breakdown-slice");
    expect(first).toHaveTextContent("Accept would refuse this: a slice cannot wait on itself.");
    expect(second).toHaveTextContent("Accept would refuse this: it waits on slice 6, and the breakdown has 2 slices.");
    expect(second).toHaveTextContent("Accept would refuse this: waiting on slice 1 closes a loop, so none of these slices could ever start.");
    expect(`${first?.textContent}${second?.textContent}`).not.toMatch(/refuse \d|index \d/);
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
    // a mutation fires after the click returns: read the calls once anything Cancel set off has had its turn
    await new Promise((settled) => setTimeout(settled, 50));
    expect(posts(calls)).toEqual([]);
  });

  it("says a one-slice breakdown files 1 issue", async () => {
    const one = breakdown({ payload: { issues: [{ title: "Tour player" }] } });
    fakeCore(() => ({ body: { suggestions: [one], open: 1 } }));
    renderWithQuery(<RequirementSuggestions projectId="p1" reqKey="REQ-31" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(screen.getByTestId("accept-step")).toHaveTextContent("Accepting files 1 issue at draft against r2.");
  });

  // ISS-281's judge: with the step open, the row's own Accept or Reject closed it and dropped the typed reason
  it("keeps the typed reason: the row's Accept and Reject are off while a step is open, and each step has its Cancel", async () => {
    const calls = listed();
    const accept = await screen.findByRole("button", { name: "Accept" });
    const reject = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(accept);
    fireEvent.change(within(screen.getByTestId("accept-step")).getByRole("textbox"), { target: { value: "owner signed it" } });
    expect(accept).toBeDisabled();
    expect(reject).toBeDisabled();
    fireEvent.click(reject);
    fireEvent.click(accept);
    expect(within(screen.getByTestId("accept-step")).getByRole("textbox")).toHaveValue("owner signed it");
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(reject);
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
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

// ISS-464 (REQ-35 BC-10, BC-11, BC-12): the BA's drafted revision carries its picture, which the
// person deciding it reads before Accept, labelled a rough sketch, by its text alternative.
describe("a drafted revision's picture, before Accept", () => {
  const drafted = (picture: unknown): SuggestionView =>
    ({
      id: "s2",
      kind: "revision_diff",
      status: "proposed",
      target: { type: "requirement", id: "r1" },
      baseRevision: 1,
      payload: {
        reason: "the refund path",
        kind: "process",
        picture,
        criteria: [{ code: "BC-1", body: "a buyer asks for a refund" }],
      },
      producerKind: "ba_assistant",
      model: null,
      createdAt: "2026-10-09T05:00:00.000Z",
    }) as SuggestionView;
  const flow = {
    kind: "flow",
    content: {
      nodes: [
        { id: "ask", label: "Buyer asks" },
        { id: "paid", label: "Refund paid" },
      ],
      edges: [{ from: "ask", to: "paid" }],
    },
  };

  async function lines(view: SuggestionView) {
    fakeCore(() => ({ body: { suggestions: [view], open: 1 } }));
    renderWithQuery(<RequirementSuggestions projectId="p1" reqKey="REQ-31" />);
    const opener = await screen.findByText("Show details");
    fireEvent.click(opener);
    const panel = opener.closest("details");
    if (!panel) throw new Error("the details panel is not drawn");
    return within(panel).getAllByRole("listitem").map((li) => li.textContent);
  }

  it("shows it as a rough sketch, read by the text alternative written from its content", async () => {
    expect(await lines(drafted(flow))).toEqual([
      "Rough sketch, not final design · A flow of 2 steps: Buyer asks to Refund paid.",
      "BC-1 · a buyer asks for a refund",
    ]);
  });

  it("reads the text alternative the draft wrote, where it wrote one", async () => {
    expect((await lines(drafted({ ...flow, alt: "Refunds are paid once asked." })))[0]).toBe(
      "Rough sketch, not final design · Refunds are paid once asked.",
    );
  });

  it("shows no picture line for a draft that carries none", async () => {
    expect(await lines(drafted(undefined))).toEqual(["BC-1 · a buyer asks for a refund"]);
  });
});
