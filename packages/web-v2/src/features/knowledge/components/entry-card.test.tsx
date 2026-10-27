// @vitest-environment jsdom
//
// ISS-1228 round 23 (master's read of the r23 after-shots, criterion 243): an entry body that could
// not be read said "…then try again." with no way to try again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);

const refetch = vi.fn();
let error: unknown = null;
vi.mock("../hooks", () => ({
  useKnowledgeEntry: () => ({ data: undefined, isLoading: false, isError: true, error, refetch }),
  useUpsertEntry: () => ({ mutate: vi.fn() }),
}));

const { EntryCard } = await import("./entry-card");

const ROW = {
  id: "k1", slug: "build", kind: "guide", title: "Build", injection: "on_demand",
  confidence: "verified", authoredBy: "human", orderIndex: 0, updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => refetch.mockClear());
afterEach(cleanup);

describe("an entry body that could not be read", () => {
  // ISS-1229 r50 (criterion 478): Retry only where a second read can change the answer.
  it("offers no Retry under a refusal a second read cannot change", () => {
    error = new ApiError(409, "Try again in a minute.", "X");
    render(<EntryCard projectId="p1" row={ROW} canManage={false} defaultOpen />);
    expect(screen.getByRole("status")).toHaveTextContent("This entry's body could not be read.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry where the server could not answer, and reads the body again", () => {
    error = new ApiError(503, "Busy.", "X");
    render(<EntryCard projectId="p1" row={ROW} canManage={false} defaultOpen />);
    expect(screen.getByRole("status")).toHaveTextContent("This entry's body could not be read.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers no Retry under a 401, which signs the person out", () => {
    error = new ApiError(401, "Unauthenticated", "UNAUTHENTICATED");
    render(<EntryCard projectId="p1" row={ROW} canManage={false} defaultOpen />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
