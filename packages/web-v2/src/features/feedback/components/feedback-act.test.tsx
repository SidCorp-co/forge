// Feedback shows on its face what a person acts on (REQ-11 BC-18, BC-19): a row leads with the item's
// title, what it is about reads as the target's title, and the keys sit in tooltips. A row names who
// acts next, never the reporter (FB-583).
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-band.tsx
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-screen.tsx

import type { QueryKey } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { FEEDBACK_SEED, P } from "@/test/vi-chrome-feedback";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { FeedbackSummary } from "../types";
import { FeedbackScreen } from "./feedback-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const WORDS = ["Login loops", "Export is empty", "Totals drift", "Slow board", "Wrong date", "Lost draft", "Stale badge", "Bad link"];

/** The fixture's list, its titles words of their own: the fixture's titles carry their keys, which would read as a key on the face. */
const seed = (): [QueryKey, unknown][] =>
  FEEDBACK_SEED.map(([key, value]) => {
    if (key[0] !== "feedback" || key.length !== 2) return [key, value];
    const list = value as { feedback: FeedbackSummary[] };
    return [key, { ...list, feedback: list.feedback.map((r, i) => ({ ...r, title: WORDS[i % WORDS.length] })) }];
  });

const feedback = () => render(<Seeded data={seed()}><FeedbackScreen projectId={P} slug="hop" /></Seeded>);

describe("Feedback leads with titles, never keys (REQ-11 BC-19)", () => {
  it("draws no feedback, requirement or issue key as text on its face", () => {
    const { container } = feedback();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("has no Key column: each row's first text is its title, the key its tooltip", () => {
    feedback();
    const list = screen.getByTestId("grouped-list");
    expect(within(list).getByTestId("list-header").textContent).not.toMatch(/^Key/);
    const row = within(list).getAllByTestId("list-row")[0];
    expect(row.textContent?.startsWith("Login loops")).toBe(true);
    expect(row.querySelector(`[title='${row.dataset.key}']`)?.textContent).toBe("Login loops");
  });

  it("says what an item is, what it is about by the target's title, and how bad on its chip's hover (ISS-903)", () => {
    const { container } = feedback();
    const chip = screen.getAllByTestId("feedback-row-state")[0];
    expect(chip).toHaveAttribute("data-reason", expect.stringContaining("About Requirement Dang nhap"));
    expect(chip.dataset.reason).toMatch(/Severity/);
    for (const facts of screen.getAllByTestId("row-facts")) expect(facts.textContent).not.toMatch(/About|Severity/);
    expect(container.textContent).not.toContain("REQ-1");
  });

  // REQ-43 r3 BC-14 (owner, 2026-11-10): the page opens on its overview, above the list, and each
  // phase's count there is the list's own (L-57)
  it("opens on its overview band above the list, its phase counts summing to the list's groups", () => {
    feedback();
    const band = screen.getByTestId("feedback-band");
    const list = screen.getByTestId("grouped-list");
    expect(band.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const flow = within(band).getAllByTestId("coverage-part-count").map((c) => Number(c.textContent));
    const groups = within(list).getAllByTestId("group-count").map((c) => Number(c.textContent));
    expect(flow.reduce((a, b) => a + b, 0)).toBe(groups.reduce((a, b) => a + b, 0));
    expect(within(band).getByTestId("feedback-band-chart")).toBeInTheDocument();
  });

  // ISS-1197 r2 (live judge, cf16fab7a0): the band read Verified 277 and Declined 195 by phase over
  // the rows less their duplicates, while the list under it grouped Done 301 and Dropped 196 by whose
  // turn it is, its 25 duplicates included. The band counts what the list counts, by the list's own
  // groups, from core's read: a duplicate is an occurrence of its original, never a row of its own
  // (REQ-66 BC-3).
  it("counts by the list's own groups, from core's counts, the duplicates in neither", () => {
    const [rows] = FEEDBACK_SEED.filter(([key]) => key[0] === "feedback" && key.length === 2).map(([, v]) => (v as { feedback: FeedbackSummary[] }).feedback);
    const pick = (key: string) => rows?.find((r) => r.key === key) as FeedbackSummary;
    const planted = [
      { ...pick("FB-1"), title: "Login loops" },
      { ...pick("FB-5"), title: "Export is empty" },
      { ...pick("FB-5"), key: "FB-8", id: "f8", title: "Totals drift", route: { route: "duplicate" } },
      { ...pick("FB-6"), title: "Slow board" },
    ] as FeedbackSummary[];
    const counts = { needs_you: 1, running: 0, queued: 0, overdue: 0, waiting: 0, done: 1, dropped: 1 };
    render(
      <Seeded data={seed().map(([key, value]) => (key[0] === "feedback" && key.length === 2 ? [key, { ...(value as object), feedback: planted, counts, total: 3, open: 1 }] : [key, value]))}>
        <FeedbackScreen projectId={P} slug="hop" />
      </Seeded>,
    );
    const band = screen.getByTestId("feedback-band");
    const flow = Object.fromEntries(within(band).getAllByTestId("coverage-part").map((p): [string, number] => [p.getAttribute("data-key") ?? "", Number(within(p).getByTestId("coverage-part-count").textContent)]));
    const list = Object.fromEntries(
      within(screen.getByTestId("grouped-list"))
        .getAllByTestId("list-group")
        .map((g): [string, number] => [g.getAttribute("data-group") ?? "", Number(within(g).getByTestId("group-count").textContent)])
        .filter(([, n]) => n > 0),
    );
    expect(flow).toEqual({ needs_you: 1, done: 1, dropped: 1 });
    expect(list).toEqual(flow);
    const figure = (key: string) => within(band).getAllByTestId("band-figure").find((f) => f.getAttribute("data-key") === key);
    expect(figure("reports")).toHaveTextContent("3");
    expect(figure("open")).toHaveTextContent("1");
    expect(screen.queryByText("Totals drift")).toBeNull();
  });

  it("never names the reporter on a row: who acts next is its Waiting on", () => {
    feedback();
    for (const row of screen.getAllByTestId("list-row")) {
      // Lan may be who acts next on a row; anywhere else on it she is the reporter
      const rest = row.cloneNode(true) as HTMLElement;
      rest.querySelector("[data-testid=waiting-on]")?.remove();
      expect(rest.textContent).not.toMatch(/\bLan\b/);
    }
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = feedback();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});
