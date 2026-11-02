// Requirements shows on its face what a person acts on (REQ-11 BC-18, BC-19): a row leads with the
// requirement's name, its key the name's tooltip; the suggestions strip says how many wait, and why
// none applies on its own is its tooltip, never a clause on the face.

import type { QueryKey } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { faceWords, rawKeysOnFace } from "@/test/screen-face";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import type { RequirementSummary } from "../types";
import { RequirementsScreen } from "./requirements-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NAMES = ["Sign-in", "Invoice export"];

/** The fixture's list, its titles words of their own: the fixture's titles carry their keys, which would read as a key on the face. */
const seed = (): [QueryKey, unknown][] =>
  reqQueries().map(([key, value]) => {
    if (key[0] !== "requirements" || key.length !== 2) return [key, value];
    const list = value as { requirements: RequirementSummary[] };
    return [key, { ...list, requirements: list.requirements.map((r, i) => ({ ...r, title: NAMES[i] })) }];
  });

const requirements = () => render(<Seeded data={seed()}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded>);

describe("Requirements leads with names, never keys (REQ-11 BC-19)", () => {
  it("draws no requirement or issue key as text on its face", () => {
    const { container } = requirements();
    expect(rawKeysOnFace(container)).toEqual([]);
  });

  it("has no Key column: each row's first text is the requirement's name, the key its tooltip", () => {
    requirements();
    const list = screen.getByTestId("grouped-list");
    expect(within(list).getByTestId("list-header").textContent).not.toMatch(/^Key/);
    const row = within(list).getAllByTestId("list-row")[0];
    expect(row.textContent?.startsWith("Sign-in")).toBe(true);
    expect(within(row).getByTitle("REQ-1").textContent).toMatch(/^Sign-in/);
  });

  it("says how many suggestions wait, the rule that none applies on its own in the tooltip (BC-18)", () => {
    requirements();
    const strip = screen.getByTestId("assistant-strip-collapsed");
    expect(strip.textContent).toBe("Suggestions 2Show");
    expect(strip.getAttribute("title")).toBe("Never applied on its own");
  });

  it("leads an opened suggestion with the requirement's name, not its key", () => {
    requirements();
    fireEvent.click(screen.getByTestId("assistant-strip-collapsed"));
    const row = screen.getAllByTestId("assistant-strip-row")[0];
    expect(row.textContent?.startsWith("Sign-in")).toBe(true);
    expect(within(row).getByTitle("REQ-1").textContent).toBe("Sign-in");
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = requirements();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});
