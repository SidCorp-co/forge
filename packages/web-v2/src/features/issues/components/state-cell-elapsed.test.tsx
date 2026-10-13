// @vitest-environment jsdom
//
// ISS-1033 — the stale row has to be told from a fresh one WITHOUT reading the
// number. jsdom loads no stylesheet, so a test that rendered the cell and read
// `getComputedStyle` would report the browser default for every row and pass
// whatever the classes said. The two assertions below are therefore about the
// two facts the rendered colour actually rests on, each of which can go red on
// its own: the span asks for the mark by a class the cascade lets through, and
// that class is declared where it outranks `.fg-caption`.
// ISS-1155 — the figure sits in the state cell, the last write only where nothing better is recorded.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusLabel } from "../derive";
import { ISSUE_STATUSES, type IssueRow, type IssueStatus } from "../types";
import { StatusCell } from "./issue-row-actions";

expect.extend(matchers);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const HOUR = 3_600_000;

/** A row last written `agoMs` before NOW, at a status whose state carries a figure. */
const rowWrittenAgo = (agoMs: number, status: IssueStatus = "open"): IssueRow =>
  ({
    id: "i",
    projectId: "p",
    issSeq: 1033,
    displayId: "ISS-1033",
    title: "A row",
    status,
    priority: "medium",
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: "u",
    creatorEmail: null,
    creatorIsAgent: false,
    creatorLabel: "A person",
    reopenCount: 0,
    mergedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: new Date(NOW - agoMs).toISOString(),
    agentStatus: null,
  }) as IssueRow;

/** The span that carries the figure: the one that is neither the status word nor the dot. */
const figureSpan = (row: IssueRow) => {
  const { container } = render(<StatusCell row={row} now={NOW} />);
  const span = [...container.querySelectorAll("span")].find((s) => s.classList.contains("tabular-nums"));
  return span ?? null;
};

const classesOf = (agoMs: number) => {
  const span = figureSpan(rowWrittenAgo(agoMs));
  if (!span) throw new Error("the state cell rendered no figure");
  return span.className.split(/\s+/).filter(Boolean);
};

// A utility that colours or weights text. Any of these on the same span as
// `fg-caption` is a no-op, so a class list carrying one is a mark that is not
// being drawn.
const SWALLOWED =
  /^(font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|text-(?!\[?(xs|sm|base|lg|xl|\d)).*(muted|subtle|default|accent|\[color:))/;

describe("the stale mark reaches the cascade", () => {
  it("asks for the mark by a class that is not swallowed by fg-caption", () => {
    const stale = classesOf(48 * HOUR);
    expect(stale).toContain("fg-caption-stale");
    expect(stale.filter((c) => SWALLOWED.test(c))).toEqual([]);
  });

  it("leaves a freshly moved row unmarked, and asks it for no dead colour either", () => {
    const fresh = classesOf(2 * HOUR);
    expect(fresh).not.toContain("fg-caption-stale");
    expect(fresh.filter((c) => SWALLOWED.test(c))).toEqual([]);
  });

  it("prints no figure for a settled row rather than a dash or a zero", () => {
    for (const status of ["closed", "dropped"] as const) {
      expect(figureSpan(rowWrittenAgo(48 * HOUR, status)), status).toBeNull();
    }
  });
});

// ISS-1097 — the column said "Waiting" over a figure that is not a wait, and titled itself
// "No movement in 2d" / "Last moved 2h ago" over a figure that is neither. `issues.updated_at` is
// reset by an agent's claim or lease renewal, in which no field of the issue changes, and is not
// moved at all by a comment. So the copy has to name the measurement AND both surprises: a reader
// who is told only "last updated" still reads the reset as movement.
describe("the figure says what it measures", () => {
  const titleOf = (stale: boolean) =>
    figureSpan(rowWrittenAgo(stale ? 48 * HOUR : 2 * HOUR))?.getAttribute("title") ?? "";

  it("names the measurement as a write to this issue, on both branches", () => {
    for (const stale of [true, false]) {
      expect(titleOf(stale), String(stale)).toMatch(/written to this issue|this issue was last written/i);
    }
  });

  it("says a comment on its own does not reset it, on both branches", () => {
    for (const stale of [true, false]) {
      expect(titleOf(stale), String(stale)).toMatch(/comment on its own does not/i);
    }
  });

  it("says an agent's claim or lease renewal does reset it, on both branches", () => {
    for (const stale of [true, false]) {
      expect(titleOf(stale), String(stale)).toMatch(/claim or lease renewal/i);
    }
  });

  it("claims neither movement nor time-in-status, on either branch", () => {
    for (const stale of [true, false]) {
      const said = titleOf(stale);
      expect(said, String(stale)).not.toMatch(/last moved|no movement|since it moved/i);
      expect(said, String(stale)).not.toMatch(/\bwaiting\b/i);
      expect(said, String(stale)).not.toMatch(/at this status|in this status/i);
    }
  });
});

describe("the column heading", () => {
  const view = readFileSync(join(import.meta.dirname, "issues-list-view.tsx"), "utf8");
  const headings = [...view.matchAll(/role="columnheader"[^>]*>\s*([A-Za-z]+)\s*<\/GridPart>/gu)].map((m) => m[1].trim());

  it("is read from a file that actually has the header in it", () => {
    expect(headings).toContain("State");
    expect(headings).toEqual(expect.arrayContaining(["ID", "Title", "Priority"]));
  });

  it("is no kernel status's word", () => {
    const words = new Set(ISSUE_STATUSES.map(statusLabel));
    expect(words.has("State")).toBe(false);
    for (const h of headings) expect(words.has(h), h).toBe(false);
  });
});

describe("the mark outranks the type style it sits beside", () => {
  const css = readFileSync(
    join(import.meta.dirname, "../../../styles/tokens.css"),
    "utf8",
  );

  it("declares fg-caption-stale AFTER fg-caption, which is what makes it win", () => {
    const caption = css.indexOf(".fg-caption {");
    const stale = css.indexOf(".fg-caption-stale {");
    expect(caption).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(caption);
  });

  it("gives the mark both of the properties fg-caption would otherwise set", () => {
    const rule = css.slice(
      css.indexOf(".fg-caption-stale {"),
      css.indexOf("}", css.indexOf(".fg-caption-stale {")),
    );
    expect(rule).toMatch(/font-weight:\s*[6-9]00/);
    expect(rule).toMatch(/color:\s*var\(--amber-600\)/);
  });

  it("keeps the mark unlayered, as the type style it has to outrank is", () => {
    const before = css.slice(0, css.indexOf(".fg-caption-stale {"));
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened).toBeLessThanOrEqual(closed);
  });
});
