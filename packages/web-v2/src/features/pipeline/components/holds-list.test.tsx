// @vitest-environment jsdom
//
// A held row's reason is shown whole where it fits three lines, and the whole of a longer one stays
// reachable without hover: where the three lines clip, a toggle opens it in place.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldIssue, LiveSession } from "../types";
import { HoldsList } from "./holds-list";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = Date.parse("2026-10-15T05:00:00Z");
const LONG =
  "Dispatcher facts, round 2. The judge passed every other owed criterion but failed criterion 24: the largest spend segment cannot be seen. Read its verdicts first, then fix it and add a guard.";

const held = (why: string): HeldIssue => ({
  issueId: "i1",
  displayId: "ISS-1",
  title: "An issue",
  status: "in_progress",
  holders: [{ by: "claim", holder: "iss-1-abc", renewedAt: "2026-10-15T04:59:00Z", expiresAt: null, next: why }],
});

/** jsdom lays nothing out, so the clip is planted: a box shorter, and narrower, than what it holds. */
function layOut(box: { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(box.scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(box.clientHeight);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(box.scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(box.clientWidth);
}

/** Past three lines: taller than its box. */
const CLIPS = { scrollHeight: 120, clientHeight: 60, scrollWidth: 300, clientWidth: 300 };
/** Wider than one line, inside three: what the Why column holds at 1280 for a one-sentence reason. */
const FITS_THREE_LINES = { scrollHeight: 40, clientHeight: 60, scrollWidth: 400, clientWidth: 300 };
const SHORT = "Which export order ships, the legacy one or the new one?";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a held row's reason", () => {
  it("is held to three lines, with the whole reason in its title", () => {
    layOut(CLIPS);
    render(<HoldsList holds={[held(LONG)]} sessions={[]} slug="pair" now={NOW} />);
    const reason = screen.getByText(LONG);
    expect(reason.className).toMatch(/\bline-clamp-3\b/);
    expect(reason).toHaveAttribute("title", LONG);
  });

  it("opens the whole reason in place where three lines clip it, and closes it again", () => {
    layOut(CLIPS);
    render(<HoldsList holds={[held(LONG)]} sessions={[]} slug="pair" now={NOW} />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    const reason = screen.getByText(LONG);
    expect(reason.className).not.toMatch(/\bline-clamp-3\b/);
    expect(reason.className).toMatch(/\bbreak-words\b/);
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(screen.getByText(LONG).className).toMatch(/\bline-clamp-3\b/);
  });

  it("shows a reason wider than one line and inside three whole, with no toggle", () => {
    layOut(FITS_THREE_LINES);
    render(<HoldsList holds={[held(SHORT)]} sessions={[]} slug="pair" now={NOW} />);
    expect(screen.getByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
});

describe("a held row's issue", () => {
  it("keeps its key on one line beside a long title", () => {
    render(<HoldsList holds={[held("Short reason")]} sessions={[]} slug="pair" now={NOW} />);
    expect(screen.getByText("ISS-1").parentElement?.className).toMatch(/\bwhitespace-nowrap\b/);
  });
});

describe("a Held row a session holds (ISS-1228 criterion 35)", () => {
  const quiet: LiveSession = {
    id: "s9",
    kind: "run_session",
    title: "run: ISS-1",
    status: "running",
    runtimeState: "working",
    deviceId: "d1",
    deviceName: "box-a",
    parentSessionId: null,
    startedAt: "2026-10-15T04:00:00Z",
    lastHeartbeatAt: "2026-10-15T04:57:00Z",
    createdAt: "2026-10-15T04:00:00Z",
    issues: [],
    report: null,
  };
  const bySession: HeldIssue = {
    issueId: "i1",
    displayId: "ISS-1",
    title: "An issue",
    status: "in_progress",
    holders: [
      {
        by: "session",
        sessionId: "s9",
        sessionTitle: "run: ISS-1",
        sessionKind: "run_session",
        deviceName: "box-a",
        since: "2026-10-15T04:00:00Z",
      },
    ],
  };

  it("says what its quiet session last reported and how long ago, never that a session is working it", () => {
    render(<HoldsList holds={[bySession]} sessions={[quiet]} slug="pair" now={NOW} />);
    expect(screen.getByText("Last reported working · 3m ago")).toBeInTheDocument();
    expect(screen.queryByText(/is working it/)).not.toBeInTheDocument();
  });
});
