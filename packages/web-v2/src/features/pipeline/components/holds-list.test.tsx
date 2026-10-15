// @vitest-environment jsdom
//
// A held row's reason sits on one line however long it runs, and the whole of it stays reachable
// without hover: where the line clips, a toggle opens it in place.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldIssue } from "../types";
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

/** jsdom lays nothing out, so the clip is planted: a box narrower than what it holds. */
function layOut(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a held row's reason", () => {
  it("sits on one line, with the whole reason in its title", () => {
    layOut(900, 300);
    render(<HoldsList holds={[held(LONG)]} slug="pair" now={NOW} />);
    const reason = screen.getByText(LONG);
    expect(reason.className).toMatch(/\btruncate\b/);
    expect(reason).toHaveAttribute("title", LONG);
  });

  it("opens the whole reason in place where the line clips, and closes it again", () => {
    layOut(900, 300);
    render(<HoldsList holds={[held(LONG)]} slug="pair" now={NOW} />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    const reason = screen.getByText(LONG);
    expect(reason.className).not.toMatch(/\btruncate\b/);
    expect(reason.className).toMatch(/\bbreak-words\b/);
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(screen.getByText(LONG).className).toMatch(/\btruncate\b/);
  });

  it("offers no toggle where the reason fits its line", () => {
    layOut(120, 300);
    render(<HoldsList holds={[held("Short reason")]} slug="pair" now={NOW} />);
    expect(screen.getByText("Short reason")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
});

describe("a held row's issue", () => {
  it("keeps its key on one line beside a long title", () => {
    render(<HoldsList holds={[held("Short reason")]} slug="pair" now={NOW} />);
    expect(screen.getByText("ISS-1").parentElement?.className).toMatch(/\bwhitespace-nowrap\b/);
  });
});
