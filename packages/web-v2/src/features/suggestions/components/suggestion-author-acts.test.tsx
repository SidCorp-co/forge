// A suggestion's author revises or withdraws their own while it waits; nobody else is offered
// either. A revise sends the payload as it should read (the words typed over the original, or every
// field as typed) and core withdraws the original; a withdraw is confirmed first.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { SuggestionView } from "../types";
import { fieldLabel, revisedPayload, wordFields } from "./suggestion-author-acts";
import { RequirementSuggestions } from "./suggestion-list";

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));

afterEach(() => vi.unstubAllGlobals());

const P = "p1";
const mine = {
  id: "s-mine",
  kind: "revision_diff",
  status: "proposed",
  target: { type: "requirement", id: "r1" },
  baseRevision: 1,
  producerKind: "person",
  producerId: "u-me",
  model: null,
  createdAt: "2026-10-08T13:43:03.000Z",
  payload: { reason: "add the progress analysis", tldr: "Progress", criteria: [{ code: "BC-1", body: "it holds" }] },
} as unknown as SuggestionView;
const theirs = { ...mine, id: "s-theirs", producerId: "u-other" } as unknown as SuggestionView;

function listed(rows: SuggestionView[]) {
  return fakeCore((c) => (c.method === "GET" ? { body: { suggestions: rows, open: rows.length } } : { status: 201, body: { suggestion: { ...mine, id: "s-new" } } }));
}

/** The one card a list of the author's own suggestion draws. */
const card = async () => {
  const cards = await screen.findAllByTestId("requirement-suggestion");
  expect(cards).toHaveLength(1);
  const [only] = cards;
  if (!only) throw new Error("no suggestion card");
  return only;
};

describe("the author's own acts on a waiting suggestion", () => {
  it("offers Revise and Withdraw on the author's suggestion only", async () => {
    listed([mine, theirs]);
    renderWithQuery(<RequirementSuggestions projectId={P} reqKey="REQ-1" />);
    const cards = await screen.findAllByTestId("requirement-suggestion");
    expect(cards).toHaveLength(2);
    const offered = cards.map((c) => Boolean(within(c).queryByTestId("suggestion-revise-open")));
    expect(offered.filter(Boolean)).toHaveLength(1);
    expect(cards.map((c) => Boolean(within(c).queryByTestId("suggestion-withdraw"))).filter(Boolean)).toHaveLength(1);
  });

  it("revises with the words typed over the original payload, and the reason given", async () => {
    const calls = listed([mine]);
    renderWithQuery(<RequirementSuggestions projectId={P} reqKey="REQ-1" />);
    const c = await card();
    fireEvent.click(within(c).getByTestId("suggestion-revise-open"));
    const form = within(c).getByTestId("suggestion-revise");
    fireEvent.change(within(form).getByLabelText("Summary"), { target: { value: "Progress, weekly" } });
    fireEvent.change(within(form).getByLabelText("What changed, optional"), { target: { value: "weekly, not daily" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(calls.find((x) => x.method === "POST")).toBeDefined());
    expect(calls.find((x) => x.method === "POST")).toMatchObject({
      path: `/projects/${P}/suggestions/s-mine/revise`,
      body: {
        reason: "weekly, not daily",
        payload: { reason: "add the progress analysis", tldr: "Progress, weekly", criteria: [{ code: "BC-1", body: "it holds" }] },
      },
    });
  });

  it("withdraws only once the person confirms", async () => {
    const calls = listed([mine]);
    renderWithQuery(<RequirementSuggestions projectId={P} reqKey="REQ-1" />);
    const c = await card();
    fireEvent.click(within(c).getByTestId("suggestion-withdraw"));
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nobody can accept it after.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(calls.find((x) => x.method === "POST")).toMatchObject({ path: `/projects/${P}/suggestions/s-mine/withdraw`, body: {} }));
  });
});

describe("the payload a revise sends", () => {
  it("lists the payload's own words, never a list or an object", () => {
    expect(wordFields(mine.payload)).toEqual(["reason", "tldr"]);
    expect(wordFields(null)).toEqual([]);
    expect(wordFields(["a"])).toEqual([]);
  });

  it("labels a field by its words", () => {
    expect(fieldLabel("changeSummary")).toBe("Change summary");
    expect(fieldLabel("tldr")).toBe("Tldr");
  });

  it("sends every field as typed once all fields are opened, and refuses what is not JSON", () => {
    expect(revisedPayload(mine.payload, {}, '{"tldr":"x"}')).toEqual({ ok: true, payload: { tldr: "x" } });
    expect(revisedPayload(mine.payload, {}, "{tldr: x")).toEqual({ ok: false });
    expect(revisedPayload(mine.payload, { tldr: "y" }, null)).toMatchObject({ ok: true, payload: { tldr: "y", reason: "add the progress analysis" } });
  });
});
