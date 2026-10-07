import { render, screen, within } from "@testing-library/react";
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

  it("folds identical follow-the-newer-design acts into one line that opens the list, keeping each row's own act", () => {
    const follow = (n: number): NeedsYouItem =>
      item({
        key: `REQ-${n}`,
        title: `Requirement ${n}`,
        waitingOn: { ...you, act: `Update to the approved design: Design ${n} (revision 2)`, effect: `Records that this requirement follows Design ${n} revision 2 from now on.` },
      });
    const items = [...[1, 2, 3, 4, 5, 6, 7].map(follow), item({ key: "REQ-90", title: "Agree the checkout" })];
    render(<AttentionQueue items={items} slug="hop" />);
    const fold = screen.getByTestId("follow-design-fold");
    expect(fold).toHaveTextContent("7 requirements follow a design with a newer approved revision — review");
    expect(fold).not.toHaveAttribute("open");
    expect(within(fold).getAllByTestId("list-row")).toHaveLength(7);
    expect(within(fold).getAllByTestId("waiting-on")[0]).toHaveTextContent("Update to the approved design: Design 1 (revision 2)");
    expect(screen.getByText("Needs you 8")).toBeInTheDocument();
    expect(screen.getAllByTestId("list-row")).toHaveLength(8);
  });

  it("leaves a single such act where it is, as a row", () => {
    const one = item({ key: "REQ-1", waitingOn: { ...you, act: "Update to the approved design: Design 1 (revision 2)" } });
    render(<AttentionQueue items={[one]} slug="hop" />);
    expect(screen.queryByTestId("follow-design-fold")).toBeNull();
    expect(screen.getAllByTestId("list-row")).toHaveLength(1);
  });

  it("refuses a row whose area the contract does not name instead of counting it undrawn", () => {
    const stray = item({ area: "nope" as NeedsYouItem["area"], key: "X-1" });
    expect(() => render(<AttentionQueue items={[stray]} slug="hop" />)).toThrow(/area "nope"/);
  });
});
