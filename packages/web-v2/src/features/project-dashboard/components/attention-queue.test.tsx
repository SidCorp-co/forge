// @vitest-environment jsdom
//
// ISS-1156 — an empty list is "All caught up" only where nothing is owed beyond it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusChip } from "@/design/primitives/status-chip";
import { AttentionQueue } from "./attention-queue";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("the Needs your attention list with nothing in it", () => {
  it("says all caught up where nothing is owed", () => {
    render(<AttentionQueue items={[]} cut={null} slug="pair" now={0} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("does not say all caught up where more is owed than the list reached", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, atLeast: 3, peopleCut: true }} slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("Nothing is listed to act on here.")).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of at least 3\./u)).toBeInTheDocument();
  });

  it("does not say all caught up where the response was refused", () => {
    render(<AttentionQueue items={[]} cut={null} refusal="Needs you cannot say how much it leaves out." slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByTestId("attention-refusal")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is listed to act on here.")).toBeNull();
  });

  it("does not say all caught up while a read beside its own has not arrived", () => {
    render(<AttentionQueue items={[]} cut={null} shape="unread" slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("Not all of this page is read yet")).toBeInTheDocument();
    expect(screen.getByText(/not an all clear/u)).toBeInTheDocument();
  });

  it("keeps the cut under an unread page and says nothing is listed to act on only where the read is whole", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, atLeast: 3, peopleCut: true }} shape="unread" slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.queryByText("Nothing is listed to act on here.")).toBeNull();
    expect(screen.getByText(/not all of this page is read yet/iu)).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of at least 3\./u)).toBeInTheDocument();
  });

  it.each(["quiet", "working"] as const)("says all caught up under a %s page", (shape) => {
    render(<AttentionQueue items={[]} cut={null} shape={shape} slug="pair" now={0} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("does not say all caught up under a degraded page the list does not hold the cause of", () => {
    render(<AttentionQueue items={[]} cut={null} shape="degraded" slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("No item is waiting on you")).toBeInTheDocument();
  });
});

// ISS-1228 round 9 (judge-22): at 390 a row was cut short and showed no age. Each row reads whole,
// wrapping rather than truncating, with its age beside it.
describe("a Needs you row at a phone's width", () => {
  const NOW = Date.parse("2026-10-16T10:00:00.000Z");
  const title = "run: ISS-9 waits on you — approve the database restore in Coolify before the window closes";
  const items = [
    {
      key: "session-s9",
      actionKind: "session" as const,
      actionLabel: "Open session",
      title,
      issueRef: "ISS-9",
      link: "/projects/pair/agents/s9",
      since: new Date(NOW - 3 * 3_600_000).toISOString(),
    },
  ];

  it("shows the whole title, wrapping instead of truncating, and its age", () => {
    render(<AttentionQueue items={items} cut={null} slug="pair" now={NOW} />);
    const row = screen.getByText(title);
    expect(row.className).not.toMatch(/\b(truncate|line-clamp-\d|whitespace-nowrap|overflow-hidden)\b/);
    expect(row.className).toMatch(/\bbreak-words\b/);
    const li = row.closest("li");
    expect(li?.className).toMatch(/\bflex-wrap\b/);
    expect(li?.querySelector("[data-testid=age-chip]")).toHaveTextContent("3h");
  });
});

// ISS-1228 round 9 (coordinator): the Waiting chip wore the Working sparkle. A chip that shows a
// session's status draws the mark the session chips give that status.
describe("the Needs you chip of a session waiting on you", () => {
  const drawing = (root: ParentNode | null) => {
    const svg = root?.querySelector("svg");
    return svg ? [...svg.children].map((c) => c.outerHTML).join("") : "";
  };
  const chipMark = (status: "waiting" | "running") => {
    const { container } = render(<StatusChip domain="session" status={status} />);
    const mark = drawing(container);
    cleanup();
    return mark;
  };

  it("draws the session chips' Waiting mark, never the Working sparkle", () => {
    const waiting = chipMark("waiting");
    const working = chipMark("running");
    const item = {
      key: "session-s1",
      actionKind: "session" as const,
      actionLabel: "Open session",
      title: "run: ISS-1 waits on you",
      issueRef: "ISS-1",
      link: "/projects/pair/agents/s1",
      since: new Date(0).toISOString(),
    };
    render(<AttentionQueue items={[item]} cut={null} slug="pair" now={60_000} />);
    const tag = screen.getByText("Waiting").parentElement;
    expect(drawing(tag)).toBe(waiting);
    expect(drawing(tag)).not.toBe(working);
  });
});
