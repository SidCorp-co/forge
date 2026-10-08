// REQ-33 BC-7 (r2): a memory that names no requirement, workflow or issue is about the project itself
// and is read on its Dashboard, in a flat Memory section with the same fields and acts as an item's:
// who wrote it, when, when it was last checked, why it needs a check, and Still true / Correct /
// Retire, each correction and retirement with a reason.

import type { MemoryEntry } from "@forge/contracts/memory";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { ProjectMemory } from "./project-memory";

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";

const cadence: MemoryEntry = {
  id: "m1",
  source: "note",
  sourceRef: "gotcha/cadence",
  text: "The team ships to the clinic every Tuesday morning.",
  writtenAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  writtenBy: { id: "u1", name: "Dana", agent: false },
  verifiedAt: null,
  verifiedBy: null,
  cites: [],
  staleRefs: [],
  needsCheck: ["unchecked"],
  changed: [],
  flagged: null,
  corrections: [],
  revisions: [],
  revisionCount: 0,
  retired: null,
  archivedAt: null,
  archivedBy: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("the Dashboard's Memory section", () => {
  it("lists the memories naming no item, with who wrote them, when, whether checked and why to check, and retires one with a reason", async () => {
    let live = [cadence];
    const calls = fakeCore((c: Call) => {
      if (c.path.startsWith("/memory/entries")) return { body: { items: live, counts: { live: live.length, stale: live.length, retired: 0 }, returned: live.length, total: live.length, limit: 100, offset: 0, hasMore: false } };
      if (c.method === "POST") return { body: { id: "m1" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<ProjectMemory projectId={PROJECT} slug="hop" />);
    const row = await screen.findByTestId("memory-entry");
    expect(calls[0]?.path).toContain("uncited=true");
    expect(calls[0]?.path).not.toContain("cites=");
    expect(row).toHaveTextContent("Written by Dana");
    expect(within(row).getByTestId("memory-checked")).toHaveTextContent("Never checked");
    expect(within(row).getByTestId("memory-needs-check")).toHaveTextContent("nobody has checked it");
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Not true anymore" }));
    await user.click(within(row).getByRole("button", { name: "Retire" }));
    await user.type(within(row).getByRole("textbox"), "Releases moved to Thursdays");
    live = [];
    await user.click(within(row).getByRole("button", { name: "Retire this memory" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/memory/m1/retire?projectId=${PROJECT}`, body: { reason: "Releases moved to Thursdays" } }));
    await waitFor(() => expect(screen.queryByTestId("memory-entry")).toBeNull());
  });
});
