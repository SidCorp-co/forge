// REQ-33 BC-3: where a requirement stands on the roadmap is read on the Requirements list, not on a
// Roadmap page of its own. Its roadmap grouping puts each row under Now, Next or Later by the rule
// the status report's roadmap reads (`ROADMAP_HORIZON_OF`), says under each how it is filled, and
// folds away what is on the roadmap no more.

import { REQUIREMENT_STATES, type RequirementState } from "@forge/contracts/requirements";
import { describe, expect, it, vi } from "vitest";
import { labelCopy } from "@/lib/i18n/labels";
import { productCopy } from "@/lib/i18n/product-copy";
import type { RequirementSummary } from "../types";
import { groupsOf } from "./requirements-screen";

// the rule changed once in the test below, as core's lane-rule.test.ts changes it for the status
// report's roadmap and the progress query
const moved = vi.hoisted(() => ({ on: false }));
vi.mock("@forge/contracts/project-status", async (load) => {
  const real = await load<typeof import("@forge/contracts/project-status")>();
  return {
    ...real,
    ROADMAP_HORIZON_OF: new Proxy(real.ROADMAP_HORIZON_OF, {
      get: (rule, state: string) => (moved.on && state === "agreed" ? "now" : rule[state as RequirementState]),
    }),
  };
});

const row = (key: string, state: RequirementState) => ({ key, standing: { state } }) as unknown as RequirementSummary;
const label = ((kind: string, value: string) => labelCopy("en")(kind as never, value)) as never;

describe("the Requirements list's roadmap grouping", () => {
  it("puts each requirement under Now, Next or Later by its state, and folds what is off the roadmap", () => {
    const rows = REQUIREMENT_STATES.map((s, i) => row(`REQ-${i + 1}`, s));
    const groups = groupsOf(rows, "roadmap", label, productCopy("en"));
    expect(groups.map((g) => [g.id, g.label, g.rows.map((r) => r.standing.state)])).toEqual([
      ["roadmap:now", "Now", ["in_delivery"]],
      ["roadmap:next", "Next", ["agreed"]],
      ["roadmap:later", "Later", ["draft", "deferred"]],
      ["roadmap:off", "Not on the roadmap", ["delivered", "accepted", "dropped"]],
    ]);
    expect(groups.map((g) => g.collapsed ?? false)).toEqual([false, false, false, true]);
    expect(groups[0]?.hint).toBe("In delivery: its issues are being worked. Soonest forecast landing first.");
  });

  it("follows the one lane rule when it changes, with nothing of its own to update", () => {
    moved.on = true;
    const groups = groupsOf([row("REQ-1", "in_delivery"), row("REQ-2", "agreed")], "roadmap", label, productCopy("en"));
    expect(groups.find((g) => g.id === "roadmap:now")?.rows.map((r) => r.key)).toEqual(["REQ-1", "REQ-2"]);
    moved.on = false;
  });
});
