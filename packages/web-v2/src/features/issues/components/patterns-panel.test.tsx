// The issue's standing told a person to approve or return a new pattern, and no screen showed one
// or could decide it: only REST could (judge at d911fa1a9, comment 1040ef6e). The issue page lists
// its new patterns, and a reader core says may decide one approves or returns it with a reason.

import { screen, waitFor, within } from "@testing-library/react";
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

const listed = (patterns: unknown[], decidable: string[]) => ({
  catalog: { declared: true, detail: null },
  patterns,
  dispatchable: false,
  refusal: null,
  returned: null,
  decidable,
});

function core(patterns: unknown[], decidable: string[], decided: (c: Call) => unknown = () => ({})) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path.startsWith("/issues/i1/patterns")) return { body: listed(patterns, decidable) };
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

describe("a returned pattern's reason, as the person wrote it (judge J1 on 0.4.0-dev.222)", () => {
  it("keeps a reason ending in a full stop whole, and says the hold apart from it", async () => {
    core([view({ decision: "returned", pending: false, unanswered: true, decisionReason: "Use the api-route task." })], []);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const row = await screen.findByTestId("pattern-queue-door");
    expect(row).toHaveTextContent("was returned: Use the api-route task.");
    expect(row.textContent).not.toContain("..");
    expect(within(row).getByTestId("pattern-follow")).toHaveTextContent(
      "Held from build until a catalogued or revised pattern is named.",
    );
  });

  it("says a later pattern answered the return apart from the reason too", async () => {
    core([view({ decision: "returned", pending: false, unanswered: false, decisionReason: "No." })], []);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const row = await screen.findByTestId("pattern-queue-door");
    expect(row).toHaveTextContent("was returned: No.");
    expect(row.textContent).not.toContain("..");
    expect(within(row).getByTestId("pattern-follow")).toHaveTextContent("A later pattern answered the return.");
  });
});

describe("what the issue page says around a review (judge at 9988a9335, comment 1000c87f)", () => {
  it("says a pending pattern waits on a reviewer, and shows no permission key", async () => {
    core([view({})], []);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const row = await screen.findByTestId("pattern-queue-door");
    expect(row).toHaveTextContent("Waits on a reviewer");
    expect(row.textContent).not.toContain("patterns.approve");
  });

  it("refuses a reason over the limit there, before sending anything", async () => {
    const calls = core([view({})], ["p1"]);
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const form = await screen.findByTestId("pattern-decide");
    await user.click(within(form).getByRole("textbox"));
    await user.paste("x".repeat(2001));
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "The reason is 2001 characters, over 2000. Shorten it.",
    );
    expect(within(form).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Return" })).toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  // Two reviewers decide the same pattern: Ana's approval lands first, so this reviewer's is refused
  // 409. The line shows Ana's decision; the form says theirs was not recorded, by whom, and keeps
  // what they typed (judge J1 on 0.4.0-dev.222: it unmounted and the reason went without a word).
  const raced = (decidedBy: string, decidedSession: string | null = null) => {
    let decided = false;
    return fakeCore((c) => {
      if (c.method === "GET" && c.path === "/projects/pr1/members") {
        return {
          body: [
            { userId: "u-ana", email: "ana@example.com", displayName: "Ana", kind: "human", role: "admin", createdAt: "" },
            { userId: "u-box", email: "box@example.com", displayName: null, kind: "agent", role: "member", createdAt: "" },
          ],
        };
      }
      if (c.method === "GET" && c.path.startsWith("/issues/i1/patterns")) {
        const standing = view({ decision: "approved", pending: false, decisionReason: "fits", decidedBy, decidedSession });
        return { body: listed([decided ? standing : view({})], ["p1"]) };
      }
      if (c.method === "POST" && c.path === "/issues/i1/patterns/p1/decision") {
        decided = true;
        return {
          status: 409,
          body: {
            error: {
              code: "PATTERN_ALREADY_DECIDED",
              message: "already decided",
              refusals: [{ code: "PATTERN_ALREADY_DECIDED", path: "", detail: "`queue-door` on ISS-9 was already approved; a decision is taken once" }],
            },
          },
        };
      }
      return undefined;
    });
  };

  const decideAndLose = async (typed: string) => {
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const form = await screen.findByTestId("pattern-decide");
    await user.type(within(form).getByRole("textbox"), typed);
    await user.click(within(form).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("pattern-queue-door")).toHaveTextContent("was approved: fits"));
    return screen.getByTestId("pattern-decide");
  };

  it("after a decision refused as already taken, shows the decision that stands, says by whom, and keeps the reason", async () => {
    raced("u-ana");
    const form = await decideAndLose("nothing catalogued consumes a queue");
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent("Not recorded: Ana already approved it. Your reason is kept."),
    );
    expect(within(form).getByRole("textbox")).toHaveValue("nothing catalogued consumes a queue");
    expect(within(form).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(form).queryByRole("button", { name: "Return" })).toBeNull();
  });

  it("names a run that decided first as a run", async () => {
    raced("u-box", "s-run");
    const form = await decideAndLose("mine");
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent("Not recorded: A run already approved it."));
  });

  it("names a decider who is not a member as another reviewer", async () => {
    raced("u-gone");
    const form = await decideAndLose("mine");
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent("Not recorded: Another reviewer already approved it."),
    );
  });

  it("says when the patterns could not be read, and reads them again on request", async () => {
    let failing = true;
    fakeCore((c) => {
      if (c.method !== "GET" || !c.path.startsWith("/issues/i1/patterns")) return undefined;
      if (failing) return { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } };
      return { body: listed([view({})], []) };
    });
    renderWithQuery(<PatternsPanel issueId="i1" projectId="pr1" />);
    const failed = await screen.findByTestId("issue-patterns-failed");
    expect(failed).toHaveTextContent("could not be read, so whether a new pattern holds the issue cannot be shown here");
    failing = false;
    await userEvent.setup().click(within(failed).getByRole("button", { name: "Read again" }));
    expect(await screen.findByTestId("pattern-queue-door")).toBeInTheDocument();
  });
});
