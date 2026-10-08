// The HOP journey walk (2026-10-08): "Needs a check" read 0 while 91 of 94 memories had never been
// verified. Each list now carries the count core reads by its one rule, whichever list is open.

import type { MemoryEntriesResponse } from "@forge/contracts/memory";
import { screen } from "@testing-library/react";
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
});
