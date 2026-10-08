// REQ-33 BC-2, BC-4, BC-5: what was decided and what was remembered about a requirement are read on
// the requirement itself, not on project pages of their own. Its Decisions tab lists its decisions
// and those on its issues with who, when and why; its Memory tab lists each memory naming it, with
// who wrote it, when, when it was last checked and what it names that is gone, and a person corrects
// or retires one there with a reason.

import type { MemoryEntry } from "@forge/contracts/memory";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { RequirementPage } from "./requirement-detail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";

const memory = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "m1",
  source: "note",
  sourceRef: "gotcha/clinic-name",
  text: "Referral reports keep the clinic name (REQ-1, ISS-9).",
  writtenAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-04T09:00:00.000Z",
  writtenBy: { id: "u1", name: "Dana", agent: false },
  verifiedAt: "2026-10-06T09:00:00.000Z",
  verifiedBy: { id: "u2", name: "Lan", agent: false },
  cites: [
    { ref: "REQ-1", kind: "requirement", project: "hop", state: "resolved" },
    { ref: "ISS-9", kind: "issue", project: "hop", state: "gone", why: "dropped" },
  ],
  staleRefs: [{ ref: "ISS-9", kind: "issue", why: "dropped" }],
  needsCheck: ["gone"],
  changed: [],
  flagged: null,
  corrections: [],
  revisions: [],
  revisionCount: 0,
  retired: null,
  archivedAt: null,
  archivedBy: null,
  ...over,
});

const decision = (id: string, key: string, scope: "requirement" | "issue", text: string) => ({
  id,
  target: { scope, id: `t-${id}`, key, title: null },
  intent: "decision",
  body: null,
  format: "markdown",
  decision: { decision: text, reason: "the clinic asked for it" },
  parentId: null,
  author: { id: "u1", name: "Dana", agency: "human" },
  withheld: false,
  edited: false,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
  datedAhead: null,
});

function core(entries: () => MemoryEntry[]) {
  return fakeCore((c: Call) => {
    if (c.path.startsWith("/memory/entries")) {
      const items = entries();
      return { body: { items, counts: { live: items.length, stale: 0, retired: 0 }, returned: items.length, total: items.length, limit: 100, offset: 0, hasMore: false } };
    }
    if (c.method === "POST" && c.path.startsWith("/memory/")) return { body: { id: "m1" } };
    if (c.path.startsWith(`/projects/${PROJECT}/requirements/REQ-1/decisions`)) {
      return { body: { decisions: [decision("d1", "REQ-1", "requirement", "Keep the clinic name"), decision("d2", "ISS-110", "issue", "Print it on the header")], answers: [], by: "people", folded: 0 } };
    }
    if (c.path.includes("/comments")) return { body: { comments: [], returned: 0 } };
    return HANG;
  });
}

function page(tab: "decisions" | "memory") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, "REQ-1"], reqDetail);
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab={tab} onTab={() => {}} />, client);
}

afterEach(() => vi.unstubAllGlobals());

describe("a requirement's own page", () => {
  it("lists its decisions and those on its issues, with who decided, when and why", async () => {
    core(() => []);
    page("decisions");
    const rows = await screen.findAllByTestId("decision-row");
    expect(rows.map((r) => within(r).getByText(/Keep the clinic name|Print it on the header/).textContent)).toEqual(["Keep the clinic name", "Print it on the header"]);
    expect(rows[1]).toHaveTextContent("the clinic asked for it");
    expect(rows[1]).toHaveTextContent("Dana");
    expect(within(rows[1] as HTMLElement).getByTestId("decision-target")).toHaveAttribute("href", "/projects/hop/issues/ISS-110");
  });

  it("lists each memory naming it, read by its key, with who wrote it, when it was checked and what it names that is gone", async () => {
    const calls = core(() => [memory()]);
    page("memory");
    const row = await screen.findByTestId("memory-entry");
    expect(row).toHaveTextContent("Referral reports keep the clinic name");
    expect(row).toHaveTextContent("Written by Dana");
    expect(within(row).getByTestId("memory-checked")).toHaveTextContent("by Lan");
    expect(within(row).getByTestId("memory-stale-refs")).toHaveTextContent("ISS-9 (dropped)");
    expect(calls.find((c) => c.path.startsWith("/memory/entries"))?.path).toContain("cites=REQ-1");
    expect(screen.getByRole("tab", { name: /Memory/ })).toHaveTextContent("1");
  });

  it("retires a memory from the requirement with a reason, and the list drops it", async () => {
    let live = [memory()];
    const calls = core(() => live);
    const user = userEvent.setup();
    page("memory");
    const row = await screen.findByTestId("memory-entry");
    await user.click(within(row).getByRole("button", { name: "Not true anymore" }));
    await user.click(within(row).getByRole("button", { name: "Retire" }));
    await user.type(within(row).getByRole("textbox"), "The name moved to the header");
    live = [];
    await user.click(within(row).getByRole("button", { name: "Retire this memory" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/memory/m1/retire?projectId=${PROJECT}`, body: { reason: "The name moved to the header" } }));
    await waitFor(() => expect(screen.queryByTestId("memory-entry")).toBeNull());
  });
});
