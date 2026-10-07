import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttentionQueue } from "./attention-queue";
import { baNeedsYou } from "../ba-derive";
import type { NeedsYouItem } from "@/features/needs-you/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const you = { kind: "you", who: "You", act: "approve or return revision 3", rule: "r", ref: null, dueAt: null } as const;
const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({ area: "requirements", entity: "requirement", key: "REQ-1", title: "T", waitingOn: you, touchedAt: null, ...over });

describe("the dashboard's Needs you", () => {
  it("draws the workflow row and counts exactly the rows it draws", () => {
    const payload = [item({}), item({ area: "designs", entity: "workflow", key: "hop-staff-shell-ux", title: "Staff shell · revision 3 proposed" }), item({ area: "issues", entity: "issue", key: "ISS-1" })];
    render(<AttentionQueue items={baNeedsYou(payload)} slug="hop" />);
    expect(screen.getAllByText("Workflows").length).toBeGreaterThan(0);
    expect(screen.getByText("Staff shell · revision 3 proposed")).toBeInTheDocument();
    expect(screen.getAllByTestId("waiting-on")[1]).toHaveTextContent("You · approve or return revision 3");
    expect(screen.getByText("Needs you 2")).toBeInTheDocument();
    expect(screen.getAllByTestId("list-row")).toHaveLength(2);
  });

  it("refuses a row whose area the contract does not name instead of counting it undrawn", () => {
    const stray = item({ area: "nope" as NeedsYouItem["area"], key: "X-1" });
    expect(() => render(<AttentionQueue items={[stray]} slug="hop" />)).toThrow(/area "nope"/);
  });
});
