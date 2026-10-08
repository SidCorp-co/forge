// A state cell reads the same words everywhere it is shown: the badge on the screen, the text
// fallback a door, an export or a screen reader reads. One label map per vocabulary, declared in
// contracts (`REPORT_VOCABULARY_LABELS`), and the badge's family reads that very map, not a copy.

import { REPORT_FIELD_VOCABULARIES, REPORT_VOCABULARY_LABELS, type ReportField } from "@forge/contracts/report-queries";
import { blockToText, cellText, type VisualBlock } from "@forge/contracts/visual-blocks";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { statusLabels } from "@/design/vocabulary";
import { VisualBlockProvider, VisualBlockView } from ".";
import { VOCABULARY_FAMILY } from "./cells";

afterEach(cleanup);

describe("a report column's state vocabulary", () => {
  it("is drawn by a badge family whose labels are the contracts' map itself", () => {
    for (const vocabulary of REPORT_FIELD_VOCABULARIES) {
      expect(statusLabels(VOCABULARY_FAMILY[vocabulary]), vocabulary).toBe(REPORT_VOCABULARY_LABELS[vocabulary]);
    }
  });

  it("reads the same sentence-case label in the badge and in the text fallback", () => {
    const state: ReportField = { name: "state", type: "status", label: "State", vocabulary: "requirement" };
    const block = {
      v: 1,
      kind: "table",
      columns: ["key", "state"],
      source: { runId: "run-1" },
      frame: { fields: [{ name: "key", type: "ref", label: "Requirement" }, state], rows: [{ key: "REQ-4", state: "in_delivery" }] },
    };
    render(
      <VisualBlockProvider value={{ projectSlug: undefined, sourceFacts: () => ({ queryId: "progress-by-requirement", asOf: "2026-10-08T09:00:00Z" }) }}>
        <VisualBlockView block={block} />
      </VisualBlockProvider>,
    );
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveTextContent("In delivery");
    expect(badge).toHaveAttribute("data-value", "in_delivery");
    expect(cellText(state, "in_delivery")).toBe("In delivery");
    expect(blockToText(block as unknown as VisualBlock)).toContain("| REQ-4 | In delivery |");
  });
});
