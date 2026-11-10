// Requirements shows on its face what a person acts on (REQ-11 BC-18, BC-19): a row leads with the
// requirement's name, its key the name's tooltip; the suggestions strip says how many wait, and why
// none applies on its own is its tooltip, never a clause on the face.
//
// @direct-test-of packages/web-v2/src/features/requirements/components/requirements-band.tsx
// @direct-test-of packages/web-v2/src/design/patterns/overview-band.tsx
// @direct-test-of packages/web-v2/src/design/templates/page-templates.tsx

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
    // who proposed, how many wait on the viewer and how long the oldest has waited (ISS-1191)
    expect(strip.textContent).toMatch(/^BA assistant2 to reviewoldest \S+Review$/);
    expect(strip.getAttribute("title")).toBe("Never applied on its own");
  });

  it("counts no suggestion on a dropped requirement (ISS-1191)", () => {
    const dropped = seed().map(([key, value]): [QueryKey, unknown] => {
      if (key[0] !== "requirements" || key.length !== 2) return [key, value];
      const list = value as { requirements: RequirementSummary[] };
      return [key, { ...list, requirements: list.requirements.map((r) => (r.key === "REQ-1" ? { ...r, status: "dropped" } : r)) }];
    });
    render(<Seeded data={dropped}><RequirementsScreen projectId={REQ_PROJECT} slug="hop" /></Seeded>);
    expect(screen.queryByTestId("assistant-strip-collapsed")).toBeNull();
  });

  it("leads an opened suggestion with the requirement's name, not its key", () => {
    requirements();
    fireEvent.click(screen.getByTestId("assistant-strip-collapsed"));
    const row = screen.getAllByTestId("assistant-strip-row")[0];
    expect(row.textContent?.startsWith("Sign-in")).toBe(true);
    expect(within(row).getByTitle("REQ-1").textContent).toBe("Sign-in");
  });

  // REQ-43 r3 BC-14 (owner, 2026-11-10): the page opens on its overview, above the list, and each
  // state's count there is the list's own (L-57)
  it("opens on its overview band above the list, its state counts summing to the list's groups", () => {
    requirements();
    const band = screen.getByTestId("requirements-band");
    const list = screen.getByTestId("grouped-list");
    expect(band.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const flow = within(band).getAllByTestId("coverage-part-count").map((c) => Number(c.textContent));
    const groups = within(list).getAllByTestId("group-count").map((c) => Number(c.textContent));
    expect(flow.reduce((a, b) => a + b, 0)).toBe(groups.reduce((a, b) => a + b, 0));
    expect(within(band).getByTestId("requirements-band-chart")).toBeInTheDocument();
  });

  // ISS-1198 c3 (judge run ad038e31): the band had no figure for what waits on the person; only the
  // list's Needs you group and the rail badge said it. The band reads the rail badge's own read.
  it("says on its band what waits on you, the rail badge's Needs you count, which the list's Needs you group holds", () => {
    const areas = Object.fromEntries(["requirements", "releases", "feedback", "contracts", "designs", "automation", "questions"].map((a) => [a, { you: a === "requirements" ? 1 : 0, acts: [] }]));
    render(
      <Seeded data={[...seed(), [["needs-you", REQ_PROJECT], { generatedAt: "2026-11-11T00:00:00.000Z", areas, items: [], requirementsInDelivery: 0, untriagedFeedback: 0, decisions: 0 }]]}>
        <RequirementsScreen projectId={REQ_PROJECT} slug="hop" />
      </Seeded>,
    );
    const band = screen.getByTestId("requirements-band");
    const yours = within(band).getAllByTestId("band-figure").find((f) => f.dataset.key === "waiting");
    expect(yours, "a Waiting on you figure").toBeDefined();
    expect(within(yours as HTMLElement).getByTestId("band-figure-value").textContent).toBe("1");
    const group = within(screen.getByTestId("grouped-list")).getAllByTestId("list-group").find((g) => g.dataset.group === "needs_you");
    expect(within(group as HTMLElement).getByTestId("group-count").textContent).toBe("1");
  });

  it("stays within the first view's budget of 300 words (BC-21)", () => {
    const { container } = requirements();
    expect(faceWords(container)).toBeLessThanOrEqual(300);
  });
});
