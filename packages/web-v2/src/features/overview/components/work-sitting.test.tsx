// @vitest-environment jsdom
//
// ISS-1263 — "Longest without an issue run" orders itself: a project that never ran leads, then the
// longest silence, and its headers re-sort it. The order used to be built into the rows the
// derivation returned; it now belongs to the table, so it is pinned where the table is drawn.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PulseResponse } from "../types";
import { WorkSitting } from "./work-sitting";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const NOW = Date.parse("2026-09-23T14:30:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function project(slug: string, over: { open?: number; lastIssueRunAt: string | null }) {
  return {
    id: slug,
    slug,
    name: slug,
    open: over.open ?? 0,
    in_flight: 0,
    awaiting_release: 0,
    blocked_on_person: 0,
    stuckRuns: 0,
    abandonedIssues: 0,
    lastIssueRunAt: over.lastIssueRunAt,
  };
}

const pulse = {
  work: {
    buckets: { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 },
    blockedOnPersonAges: [],
    perProject: [
      project("recent", { lastIssueRunAt: hoursAgo(2), open: 1 }),
      project("stale", { lastIssueRunAt: hoursAgo(200), open: 7 }),
      project("never", { lastIssueRunAt: null }),
      project("middling", { lastIssueRunAt: hoursAgo(30), open: 3 }),
    ],
  },
} as unknown as PulseResponse;

const rowNames = () =>
  within(screen.getByRole("table", { name: "Longest without an issue run" }))
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent);

describe("the longest-without-a-run table", () => {
  it("lists a project that never ran first, then the rest by longest silence", () => {
    render(<WorkSitting pulse={pulse} nowMs={NOW} />);
    expect(rowNames()).toEqual(["never", "stale", "middling", "recent"]);
    expect(screen.getByText("never ran")).toBeInTheDocument();
  });

  it("marks the Last run header as sorted longest first", () => {
    render(<WorkSitting pulse={pulse} nowMs={NOW} />);
    expect(screen.getByRole("columnheader", { name: /Last run/ })).toHaveAttribute("aria-sort", "descending");
  });

  it("puts the project that never ran last when the silence is sorted the other way", () => {
    render(<WorkSitting pulse={pulse} nowMs={NOW} />);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Last run/ })).getByRole("button"));
    expect(rowNames()).toEqual(["recent", "middling", "stale", "never"]);
  });

  it("orders by a work-state count when its header is activated", () => {
    render(<WorkSitting pulse={pulse} nowMs={NOW} />);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Open, not picked up/ })).getByRole("button"));
    expect(rowNames().slice(0, 3)).toEqual(["stale", "middling", "recent"]);
  });

  it("links each project to its page", () => {
    render(<WorkSitting pulse={pulse} nowMs={NOW} />);
    expect(screen.getByRole("link", { name: "stale" })).toHaveAttribute("href", "/projects/stale");
  });
});
