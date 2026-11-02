// Feedback shows on its face what a person acts on (REQ-11 BC-18, BC-19): a row leads with the item's
// title, what it is about reads as the target's title, the keys sit in tooltips, and the reporter is
// drawn once, as the row's owner.

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

  it("says what an item is, what it is about by the target's title, and how bad on its phase chip's hover (ISS-903)", () => {
    const { container } = feedback();
    const chip = screen.getAllByTestId("feedback-row-state")[0];
    expect(chip).toHaveAttribute("data-reason", expect.stringContaining("About Requirement Dang nhap"));
    expect(chip.dataset.reason).toMatch(/Severity/);
    for (const facts of screen.getAllByTestId("row-facts")) expect(facts.textContent).not.toMatch(/About|Severity/);
    expect(container.textContent).not.toContain("REQ-1");
  });

  it("names the reporter once per row, as its owner, never again in the facts line", () => {
    feedback();
    for (const facts of screen.getAllByTestId("row-facts")) expect(facts.textContent).not.toMatch(/\bLan\b/);
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = feedback();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});
