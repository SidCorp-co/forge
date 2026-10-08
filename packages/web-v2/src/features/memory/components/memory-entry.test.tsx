import type { MemoryEntry } from "@forge/contracts/memory";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { renderWithQuery } from "@/test/render";
import { MemoryEntryRow } from "./memory-entry";

// MJ-1, MJ-3: a person reads a memory with who wrote it, when, whether anyone checked it and which of
// the records it names no longer resolve, and corrects or retires it with a reason. A mirror of an
// issue offers neither act: it follows its record.

const BASE: MemoryEntry = {
  id: "m1",
  source: "note",
  sourceRef: "gotcha/flat-board",
  text: "Owner chose the flat board (ISS-1, REQ-9; epod ISS-4, core ISS-96, 779e4736a, 0.2.0).",
  writtenAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
  writtenBy: { id: "u1", name: "runner", agent: true },
  verifiedAt: null,
  cites: [
    { ref: "ISS-1", kind: "issue", project: "hop", state: "gone", why: "dropped" },
    { ref: "REQ-9", kind: "requirement", project: "hop", state: "gone", why: "missing" },
    { ref: "ISS-4", kind: "issue", project: "epod", state: "resolved" },
    { ref: "ISS-96", kind: "issue", project: null, state: "unchecked" },
    { ref: "779e4736a", kind: "commit", project: "hop", state: "unchecked", url: "https://github.com/acme/hop/commit/779e4736a" },
    { ref: "0.2.0", kind: "release", project: "hop", state: "resolved" },
  ],
  staleRefs: [
    { ref: "ISS-1", kind: "issue", why: "dropped" },
    { ref: "REQ-9", kind: "requirement", why: "missing" },
  ],
  needsCheck: ["unchecked", "gone", "flagged"],
  changed: [],
  flagged: { since: "2026-10-06T00:00:00.000Z", by: "ISS-126", reason: "ISS-126 replaced the theme this note names" },
  corrections: [],
  retired: null,
  archivedAt: null,
  archivedBy: null,
};

const row = (entry: MemoryEntry, acts = { onCorrect: vi.fn(), onRetire: vi.fn() }, lang: "en" | "vi" = "en") => {
  renderWithQuery(
    <InterfaceLanguageScope language={lang}>
      <MemoryEntryRow entry={entry} slug="hop" timeZone="UTC" busy={false} {...acts} />
    </InterfaceLanguageScope>,
  );
  return acts;
};

describe("a memory on the Memory page", () => {
  it("says it needs a check because nobody checked it in three days", () => {
    row(BASE);
    expect(screen.getByTestId("memory-needs-check").textContent).toBe("Needs a check: nobody has checked it in 3 days");
  });

  it("names the cited records that changed since it was last written or checked", () => {
    const changed: MemoryEntry = {
      ...BASE,
      cites: [
        { ref: "ISS-4", kind: "issue", project: "hop", state: "resolved", changedAt: "2026-10-06T09:00:00.000Z" },
        { ref: "REQ-2", kind: "requirement", project: "hop", state: "resolved", changedAt: "2026-10-01T09:00:00.000Z" },
        { ref: "ISS-7", kind: "issue", project: "epod", state: "resolved", changedAt: "2026-10-06T10:00:00.000Z" },
      ],
      staleRefs: [],
      flagged: null,
      needsCheck: ["changed"],
      changed: [
        { ref: "ISS-4", kind: "issue", project: "hop", state: "resolved", changedAt: "2026-10-06T09:00:00.000Z" },
        { ref: "ISS-7", kind: "issue", project: "epod", state: "resolved", changedAt: "2026-10-06T10:00:00.000Z" },
      ],
    };
    row(changed);
    expect(screen.getByTestId("memory-needs-check").textContent).toBe("Needs a check: ISS-4, epod ISS-7 changed since it was last written or checked");
  });

  it("says nothing of a check on a memory that holds", () => {
    row({ ...BASE, staleRefs: [], flagged: null, needsCheck: [], changed: [] });
    expect(screen.queryByTestId("memory-needs-check")).toBeNull();
  });

  it("names who wrote it, an agent, when, and that nobody has checked it", () => {
    row(BASE);
    const meta = screen.getByTestId("memory-meta").textContent ?? "";
    expect(meta).toContain("runner (agent)");
    expect(meta).toContain("05/10/2026");
    expect(meta).toContain("Never verified");
  });

  it("names each record it cites that no longer resolves, and the release flag as a guess", () => {
    row(BASE);
    expect(screen.getByTestId("memory-stale-refs").textContent).toBe("Names what no longer exists: ISS-1 (dropped), REQ-9 (no such requirement)");
    expect(screen.getByTestId("memory-flagged").textContent).toContain("ISS-126");
    expect(screen.getByTestId("memory-flagged").textContent).toContain("ISS-126 replaced the theme this note names");
  });

  it("links each source it cites where it lives, and says when a key belongs to a project it does not name", () => {
    row(BASE);
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("ISS-1")).toBe("/projects/hop/issues/ISS-1");
    expect(href("REQ-9")).toBe("/projects/hop/requirements/REQ-9");
    expect(href("epod ISS-4")).toBe("/projects/epod/issues/ISS-4");
    expect(href("779e4736a")).toBe("https://github.com/acme/hop/commit/779e4736a");
    expect(href("0.2.0")).toBe("/projects/hop/releases/0.2.0");
    expect(screen.queryByRole("link", { name: "ISS-96" })).toBeNull();
    expect(screen.getByTestId("memory-cites").textContent).toContain("ISS-96 (another project, not checked)");
  });

  it("names a gone record of another project with its project", () => {
    row({ ...BASE, staleRefs: [{ ref: "ISS-4", kind: "issue", why: "dropped", project: "epod" }] });
    expect(screen.getByTestId("memory-stale-refs").textContent).toBe("Names what no longer exists: epod ISS-4 (dropped)");
  });

  it("does not save a correction until a reason is given, then sends the text and the reason", () => {
    const acts = row(BASE);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByLabelText("Corrected text"), { target: { value: "Owner chose the card board (REQ-1)." } });
    const save = screen.getByRole("button", { name: "Save correction" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why"), { target: { value: "ISS-1 was dropped" } });
    fireEvent.click(save);
    expect(acts.onCorrect).toHaveBeenCalledWith("m1", { text: "Owner chose the card board (REQ-1).", reason: "ISS-1 was dropped" });
  });

  it("retires only with a reason", () => {
    const acts = row(BASE);
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    const confirm = screen.getByRole("button", { name: "Retire this memory" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why"), { target: { value: "no longer true" } });
    fireEvent.click(confirm);
    expect(acts.onRetire).toHaveBeenCalledWith("m1", { reason: "no longer true" });
  });

  it("shows who retired it and why, and offers no act on a retired row", () => {
    row({ ...BASE, archivedAt: "2026-10-07T00:00:00.000Z", retired: { by: { id: "u2", name: "Lan", agent: false }, at: "2026-10-07T00:00:00.000Z", reason: "no longer true" } });
    expect(screen.getByTestId("memory-retired").textContent).toContain("Lan");
    expect(screen.getByTestId("memory-retired").textContent).toContain("no longer true");
    expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
  });

  it("says why decay archived a row no person retired, in the reader's words", () => {
    row({ ...BASE, archivedAt: "2026-10-07T00:00:00.000Z", archivedBy: { rule: "flagged", by: "ISS-126" } });
    expect(screen.getByTestId("memory-retired").textContent).toBe("Archived on 07/10/2026: flagged possibly stale by ISS-126 and not confirmed within 14 days");
  });

  it("reads a decay archive in Vietnamese, with no English sentence of core's", () => {
    row({ ...BASE, archivedAt: "2026-10-07T00:00:00.000Z", archivedBy: { rule: "unused" } }, undefined, "vi");
    expect(screen.getByTestId("memory-retired").textContent).toBe("Lưu trữ ngày 07/10/2026: hiếm khi được đọc và chưa ai xác nhận"); // i18n-allow: the vi copy under test
  });

  it("shows an outdated verdict's evidence as written", () => {
    row({ ...BASE, archivedAt: "2026-10-07T00:00:00.000Z", archivedBy: { rule: "outdated", evidence: "ISS-9 removed the board" } }, undefined, "vi");
    expect(screen.getByTestId("memory-retired").textContent).toContain("ISS-9 removed the board");
  });

  it("says a flag gave no reason rather than passing silence as one", () => {
    row({ ...BASE, flagged: { since: "2026-10-06T00:00:00.000Z", by: "ISS-126", reason: null } });
    expect(screen.getByTestId("memory-flagged").textContent).toContain("gave no reason");
  });

  it("offers no act on the mirror of an issue", () => {
    row({ ...BASE, source: "issue" });
    expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
    expect(screen.getByTestId("memory-mirror").textContent).toBe("A copy of this project's Issue: change the Issue itself.");
  });

  it("reads in Vietnamese", () => {
    row(BASE, undefined, "vi");
    expect(screen.getByTestId("memory-meta").textContent).toContain("Chưa ai kiểm chứng"); // i18n-allow: the vi copy under test
  });
});
