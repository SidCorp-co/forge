// ISS-281's judge: the requirements list's assistant strip had no test of its own, so making its Accept
// send at once left the whole web suite green. Its Accept opens the confirm step every other accept of
// work opens: nothing is sent until it is confirmed, Cancel sends nothing, and the typed reason is sent.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/epod/requirements",
  useSearchParams: () => new URLSearchParams(),
}));
// the grouped list is not what is judged here, and it reads standing facts this fixture leaves out
vi.mock("@/design", async (orig) => ({ ...(await orig<typeof import("@/design")>()), GroupedList: () => null }));
vi.mock("@/lib/i18n/eta-clock", () => ({
  useEtaClock: () => ({ lang: "en", now: Date.now() }),
}));
vi.mock("@/features/forecast/hooks", () => ({
  useEtaSort: () => [false, () => {}],
  useRequirementForecasts: () => ({ data: undefined }),
}));

import { RequirementsScreen } from "./requirements-screen";

afterEach(() => vi.unstubAllGlobals());

const req = {
  id: "r1",
  key: "REQ-31",
  title: "Tours",
  currentRevision: 2,
  standing: { state: "agreed", attentionGroup: "you", facts: {}, waitingOn: { kind: "you" }, owner: null, touchedAt: "2026-10-06T17:00:00.000Z" },
};
const sug = {
  id: "s1",
  kind: "breakdown",
  status: "proposed",
  target: { type: "requirement", id: "r1" },
  baseRevision: 2,
  payload: { issues: [{ title: "A" }, { title: "B" }] },
  producerKind: "agent",
  model: null,
  createdAt: "2026-10-06T17:00:00.000Z",
};

function world() {
  return fakeCore((c) => {
    if (c.method === "POST") return { body: { suggestion: { ...sug, status: "accepted" } } };
    if (c.path.includes("/suggestions")) return { body: { suggestions: [sug], open: 1 } };
    if (c.path.includes("/requirements")) return { body: { requirements: [req] } };
    return { body: {} };
  });
}
const posts = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST");
const strip = async () => within(await screen.findByTestId("assistant-strip"));
/** Lets a mutation a click set off reach the fake core before the calls are read. */
const settled = () => new Promise((done) => setTimeout(done, 50));

describe("the assistant strip's Accept", () => {
  it("opens the confirm step, sends nothing on Cancel, then sends the typed reason", async () => {
    const calls = world();
    renderWithQuery(<RequirementsScreen projectId="p1" slug="epod" />);
    fireEvent.click((await strip()).getByRole("button", { name: "Accept" }));
    await settled();
    expect(posts(calls)).toEqual([]);
    const step = screen.getByTestId("accept-step");
    expect(step).toHaveTextContent("Accepting files 2 issues at draft against r2.");
    fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
    await settled();
    expect(screen.queryByTestId("accept-step")).toBeNull();
    expect(posts(calls)).toEqual([]);
    fireEvent.click((await strip()).getByRole("button", { name: "Accept" }));
    fireEvent.change(within(screen.getByTestId("accept-step")).getByRole("textbox"), { target: { value: "  PO said yes  " } });
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/suggestions/s1/accept", body: { reason: "PO said yes" } }]));
  });

  it("sends no reason when the field is left empty", async () => {
    const calls = world();
    renderWithQuery(<RequirementsScreen projectId="p1" slug="epod" />);
    fireEvent.click((await strip()).getByRole("button", { name: "Accept" }));
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/suggestions/s1/accept", body: {} }]));
  });

  it("keeps the typed reason: its Accept is off while the step is open", async () => {
    world();
    renderWithQuery(<RequirementsScreen projectId="p1" slug="epod" />);
    const opener = (await strip()).getByRole("button", { name: "Accept" });
    fireEvent.click(opener);
    fireEvent.change(within(screen.getByTestId("accept-step")).getByRole("textbox"), { target: { value: "PO said yes" } });
    expect(opener).toBeDisabled();
    fireEvent.click(opener);
    expect(within(screen.getByTestId("accept-step")).getByRole("textbox")).toHaveValue("PO said yes");
  });
});

describe("the assistant strip's Reject", () => {
  it("offers Reject, requires a reason, sends it through the reject route, and the row leaves the pending list", async () => {
    let pending = true;
    const calls = fakeCore((c) => {
      if (c.method === "POST") {
        pending = false;
        return { body: { suggestion: { ...sug, status: "rejected" } } };
      }
      if (c.path.includes("/suggestions")) return { body: { suggestions: pending ? [sug] : [], open: pending ? 1 : 0 } };
      if (c.path.includes("/requirements")) return { body: { requirements: [req] } };
      return { body: {} };
    });
    renderWithQuery(<RequirementsScreen projectId="p1" slug="epod" />);
    fireEvent.click((await strip()).getByRole("button", { name: "Reject" }));
    const submit = within(await screen.findByTestId("reject-step")).getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();
    const why = within(screen.getByTestId("reject-step")).getByRole("textbox");
    fireEvent.change(why, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    await settled();
    expect(posts(calls)).toEqual([]);
    fireEvent.change(why, { target: { value: "  Already covered by REQ-12  " } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts(calls)).toEqual([{ method: "POST", path: "/projects/p1/suggestions/s1/reject", body: { reason: "Already covered by REQ-12" } }]));
    await waitFor(() => expect(screen.queryByTestId("assistant-strip")).toBeNull());
  });

  it("Cancel sends nothing", async () => {
    const calls = world();
    renderWithQuery(<RequirementsScreen projectId="p1" slug="epod" />);
    fireEvent.click((await strip()).getByRole("button", { name: "Reject" }));
    fireEvent.click(within(await screen.findByTestId("reject-step")).getByRole("button", { name: "Cancel" }));
    await settled();
    expect(screen.queryByTestId("reject-step")).toBeNull();
    expect(posts(calls)).toEqual([]);
  });
});
