// REQ-49 BC-7 on the Approvals page: a mockup decision shows the mockup itself, in its row and run in
// place in its peek in the isolated frame, with its round, what it revises and its open comments, and
// what accepting does; it is accepted, or returned with a reason, from the peek without leaving the page.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ } from "@/test/approvals-read";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ApprovalsScreen } from "./components/approvals-screen";
import { UNDO_MS } from "./use-decide";

/** The peek's button for one answer, by the id core gave it. */
const answerIn = (peek: HTMLElement, id: string) => {
  const b = peek.querySelector<HTMLElement>(`[data-testid=approval-peek-answer][data-answer="${id}"]`);
  if (!b) throw new Error(`the peek draws no answer ${id}`);
  return b;
};

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

const PAGE = "<!doctype html><button>Approve all</button>";

function core() {
  return fakeCore(({ path, method }) => {
    if (method === "GET" && path === `/projects/${P}/needs-you/decisions`) return { body: READ };
    if (method === "GET" && path.endsWith("/mockups/MK-4/content")) return { file: PAGE, headers: { "content-type": "text/html" } };
    if (method === "POST") return { body: { ok: true } };
    return undefined;
  });
}

const mockupRow = () => {
  const row = screen.getAllByTestId("approval-row").find((r) => r.dataset.topic === "mockup");
  if (!row) throw new Error("no mockup row");
  return row;
};
const posts = <C extends { method: string }>(calls: C[]) => calls.filter((c) => c.method === "POST");

// three decisions show at a time (REQ-68 BC-3): the mockup is reached by its chip
beforeEach(() => window.history.replaceState(null, "", "/projects/hop/approvals?topic=mockup"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a mockup decision on Approvals (BC-7)", () => {
  it("shows the mockup in its row with its round, what it revises and its open comments", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    const row = mockupRow();
    expect(within(row).getByTestId("approval-mockup-standing")).toHaveTextContent("Revision 2, answering MK-3 · 1 open comments");
    const frame = await within(within(row).getByTestId("approval-row-mockup")).findByTestId("mockup-html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // no other topic draws a mockup
    const others = screen.getAllByTestId("approval-row").filter((r) => r.dataset.topic !== "mockup");
    expect(others.flatMap((r) => within(r).queryAllByTestId("approval-row-mockup"))).toEqual([]);
  });

  it("runs it in the peek beside what accepting does and a way to it full screen, and accepts it there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(mockupRow()).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    const shown = within(peek).getByTestId("approval-peek-mockup");
    expect((await within(shown).findByTestId("mockup-html")).getAttribute("sandbox")).toBe("allow-scripts");
    expect(within(shown).getByTestId("approval-mockup-standing")).toHaveTextContent("Revision 2, answering MK-3 · 1 open comments");
    expect(within(shown).getByTestId("approval-peek-mockup-full").getAttribute("href")).toBe("/projects/hop/requirements/REQ-49?mockup=MK-4&full=1");
    // what accepting does is said once, on the answer that does it
    expect(answerIn(peek, "approve")).toHaveTextContent("MK-4 is accepted for REQ-49");
    expect(within(peek).queryByTestId("approval-peek-consequences")).toBeNull();
    fireEvent.click(answerIn(peek, "approve"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/mockups/MK-4/accept` })]));
    expect(window.location.pathname).toBe("/projects/hop/approvals");
  });

  it("returns it from the peek with the reason the person typed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(mockupRow()).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    fireEvent.click(answerIn(peek, "decline"));
    fireEvent.change(within(peek).getByTestId("approval-words"), { target: { value: "The bulk bar hides the first row." } });
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() =>
      expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/mockups/MK-4/return`, body: { reason: "The bulk bar hides the first row." } })]),
    );
  });
});
