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
  text: "Owner chose the flat board (ISS-1, REQ-9).",
  writtenAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
  writtenBy: { id: "u1", name: "runner", agent: true },
  verifiedAt: null,
  cites: ["ISS-1", "REQ-9"],
  staleRefs: [
    { ref: "ISS-1", kind: "issue", why: "dropped" },
    { ref: "REQ-9", kind: "requirement", why: "missing" },
  ],
  flagged: { since: "2026-10-06T00:00:00.000Z", by: "ISS-126" },
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

  it("says why decay archived a row no person retired", () => {
    row({ ...BASE, archivedAt: "2026-10-07T00:00:00.000Z", archivedBy: "decay: unused" });
    expect(screen.getByTestId("memory-retired").textContent).toContain("decay: unused");
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
