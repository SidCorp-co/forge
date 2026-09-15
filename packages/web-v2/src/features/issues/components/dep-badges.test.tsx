// @vitest-environment jsdom
//
// ISS-1017 — `DepBadges` renders one row's relations from the search response.
// It is mounted once per desktop row and once per mobile card, so the case
// that matters here is the one no snapshot catches: that reaching for the data
// costs nothing. The `../hooks` stub THROWS rather than returning an empty
// answer, because a hook that returns `{ data: undefined }` renders exactly
// what a prop-fed component renders and the test would pass either way.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepBadges } from "./issue-table-row";
import type { IssueDependencies, IssueDependencyEdge } from "../types";

expect.extend(matchers);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../hooks", () => ({
  useIssueDeps: () => {
    throw new Error("DepBadges fetched per row — the ISS-437/ISS-1017 N+1 is back");
  },
}));

afterEach(cleanup);

const edge = (over: Partial<IssueDependencyEdge>): IssueDependencyEdge => ({
  id: "e",
  fromIssueId: "f",
  toIssueId: "t",
  kind: "blocks",
  reason: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  fromDisplayId: "ISS-1",
  fromTitle: "the blocker",
  fromStatus: "closed",
  toDisplayId: "ISS-2",
  toTitle: "the dependent",
  toStatus: "closed",
  ...over,
});

const deps = (over: Partial<IssueDependencies>): IssueDependencies => ({
  outgoing: [],
  incoming: [],
  ...over,
});

const show = (d: IssueDependencies | undefined) =>
  render(<DepBadges deps={d} slug="forge-dev" />);

describe("DepBadges reads the row, never the network", () => {
  it("renders the counts from the prop", () => {
    show(
      deps({
        incoming: [edge({ id: "in1" })],
        outgoing: [edge({ id: "out1" }), edge({ id: "out2" })],
      }),
    );
    expect(screen.getByTitle("Blocked by 1")).toBeInTheDocument();
    expect(screen.getByTitle("Blocks 2")).toBeInTheDocument();
  });

  it("renders nothing at all when the row has no relations", () => {
    const { container } = show(deps({}));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the caller did not ask for the edges", () => {
    const { container } = show(undefined);
    expect(container).toBeEmptyDOMElement();
  });
});

// cm:guard direction is the whole meaning of the chip: an INCOMING `blocks` means this issue is blocked-by, an OUTGOING one means it blocks. Swap the two and every count still renders, which is why the two are asserted against each other rather than one at a time.
describe("direction", () => {
  it("counts incoming as blocked-by and outgoing as blocks, not the reverse", () => {
    show(deps({ incoming: [edge({ id: "i" })], outgoing: [edge({ id: "o1" }), edge({ id: "o2" }), edge({ id: "o3" })] }));
    expect(screen.getByTitle("Blocked by 1")).toBeInTheDocument();
    expect(screen.getByTitle("Blocks 3")).toBeInTheDocument();
    expect(screen.queryByTitle("Blocked by 3")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Blocks 1")).not.toBeInTheDocument();
  });

  it("names a still-open blocker rather than counting it", () => {
    show(deps({ incoming: [edge({ id: "i", fromDisplayId: "ISS-9", fromStatus: "in_progress" })] }));
    expect(screen.getByTitle("Blocked by ISS-9")).toBeInTheDocument();
  });

  it("reads an outgoing parent edge as a subtask and an incoming one as the parent", () => {
    show(deps({ outgoing: [edge({ id: "s", kind: "decomposes" })], incoming: [edge({ id: "p", kind: "decomposes" })] }));
    expect(screen.getByTitle("1 subtask")).toBeInTheDocument();
    expect(screen.getByTitle("Subtask of")).toBeInTheDocument();
  });
});
