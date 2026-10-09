// The issue's standing told a person to approve or return a new pattern, and no screen showed one
// or could decide it: only REST could (judge at d911fa1a9, comment 1040ef6e). The issue page lists
// its new patterns, and a reader core says may decide one approves or returns it with a reason.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { PatternsPanel } from "./patterns-panel";

const view = (over: Record<string, unknown>) => ({
  id: "p1",
  issue: "ISS-9",
  pattern: "queue-door",
  kind: "new",
  summary: "A queue consumer as a door; no catalogued pattern consumes a queue",
  namedBy: "u-author",
  namedSession: "s-a",
  namedAt: "2026-10-09T00:00:00Z",
  decision: null,
  decidedBy: null,
  decidedSession: null,
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  retractReason: null,
  pending: true,
  unanswered: false,
  ...over,
});

function core(patterns: unknown[], decidable: string[], decided: (c: Call) => unknown = () => ({})) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path.startsWith("/issues/i1/patterns")) {
      return {
        body: {
          catalog: { declared: true, detail: null },
          patterns,
          dispatchable: false,
          refusal: null,
          returned: null,
          decidable,
        },
      };
    }
    if (c.method === "POST" && c.path === "/issues/i1/patterns/p1/decision") return { body: decided(c) };
    return undefined;
  });
}

describe("the issue's new patterns", () => {
  it("lists a pending one with its summary, and offers its review to a reader core says may decide it", async () => {
    core([view({})], ["p1"]);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const row = await screen.findByTestId("pattern-queue-door");
    expect(row).toHaveTextContent("New pattern queue-door");
    expect(row).toHaveTextContent("no catalogued pattern consumes a queue");
    expect(within(row).getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("offers no review to a reader who may not decide it: its author, or one without patterns.approve", async () => {
    core([view({})], []);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const row = await screen.findByTestId("pattern-queue-door");
    expect(within(row).queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("returns it with the reason typed, and sends nothing until a reason is given", async () => {
    const calls = core([view({})], ["p1"], () => ({ pattern: view({ decision: "returned", pending: false }) }));
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const form = await screen.findByTestId("pattern-decide");
    expect(within(form).getByRole("button", { name: "Return" })).toBeDisabled();
    await user.type(within(form).getByRole("textbox"), "the api-route pattern serves it");
    await user.click(within(form).getByRole("button", { name: "Return" }));
    const sent = calls.find((c) => c.method === "POST");
    expect(sent?.body).toEqual({ decision: "returned", reason: "the api-route pattern serves it" });
  });

  it("approves it", async () => {
    const calls = core([view({})], ["p1"], () => ({ pattern: view({ decision: "approved", pending: false }) }));
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const form = await screen.findByTestId("pattern-decide");
    await user.type(within(form).getByRole("textbox"), "nothing catalogued consumes a queue");
    await user.click(within(form).getByRole("button", { name: "Approve" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      decision: "approved",
      reason: "nothing catalogued consumes a queue",
    });
  });

  it("shows an unanswered return with its reason, and nothing for an issue that names only catalogued patterns", async () => {
    core([view({ decision: "returned", pending: false, unanswered: true, decisionReason: "use api-route" })], []);
    const { unmount } = renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    expect(await screen.findByTestId("pattern-queue-door")).toHaveTextContent("was returned: use api-route");
    unmount();
    core([view({ kind: "reuse", pattern: "api-route", pending: false, summary: null })], []);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("issue-patterns")).toBeNull();
  });
});
