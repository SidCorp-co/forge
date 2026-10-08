// The HOP journey walk (2026-10-08): "Needs a check" read 0 while 91 of 94 memories had never been
// verified. Each list now carries the count core reads by its one rule, whichever list is open.

import type { MemoryEntriesResponse, MemoryEntry } from "@forge/contracts/memory";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { MemoryScreen } from "./memory-screen";

const EMPTY: MemoryEntriesResponse = {
  items: [],
  counts: { live: 94, stale: 91, retired: 4 },
  returned: 0,
  total: 94,
  limit: 100,
  offset: 0,
  hasMore: false,
};

describe("the Memory page's lists", () => {
  it("names how many memories each list holds, the ones needing a check included", async () => {
    fakeCore((call) => (call.path.startsWith("/memory/entries?") ? { body: EMPTY } : undefined));
    renderWithQuery(<MemoryScreen projectId="p1" slug="hop" />);
    expect((await screen.findAllByText("Needs a check (91)")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Current (94)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Retired (4)").length).toBeGreaterThan(0);
  });

  it("marks the rows a person picks on the needs-a-check list checked in one call, and only those", async () => {
    const entry = (id: string): MemoryEntry => ({
      id,
      source: "note",
      sourceRef: `gotcha/${id}`,
      text: `Text of ${id}.`,
      writtenAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
      writtenBy: null,
      verifiedAt: null,
      verifiedBy: null,
      cites: [],
      staleRefs: [],
      needsCheck: ["unchecked"],
      changed: [],
      flagged: null,
      corrections: [],
      retired: null,
      archivedAt: null,
      archivedBy: null,
    });
    window.history.replaceState(null, "", "/?state=stale");
    const calls = fakeCore((call) => {
      if (call.path.startsWith("/memory/entries?")) return { body: { ...EMPTY, items: [entry("a"), entry("b"), entry("c")], returned: 3, total: 3 } };
      if (call.path.startsWith("/memory/verify?")) return { body: { verified: [] } };
      return undefined;
    });
    renderWithQuery(<MemoryScreen projectId="p1" slug="hop" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select gotcha/a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select gotcha/c" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark checked (2)" }));
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/memory/verify?"))).toBe(true));
    const sent = calls.find((c) => c.path.startsWith("/memory/verify?"));
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toEqual({ ids: ["a", "c"] });
    window.history.replaceState(null, "", "/");
  });
});
