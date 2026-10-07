// A BA reads what an act changes before pressing it, and on a phone sees progress before the long content.

import { forecastWait, RULE, say, waitingOn } from "@/test/said";
import type { ScopeForecast } from "@forge/contracts/forecast";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequirementPhoneProgress } from "./requirement-facts";
import { RequirementBanner } from "./standing-bits";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const landed = { ...stamp, kind: "landed" as const, landedAt: at(-30) };
const approval = { kind: "person" as const, mode: "approval" as const, ...forecastWait(say("standing.who.named", { name: "Dana Lee" }), say("standing.act.cutThenApprove", { v: "0.1.0" }), RULE), version: "0.1.0", holders: [] };
const scope: ScopeForecast = { ...stamp, scope: "requirement", key: "REQ-19", title: "t", progress: { total: 2, shipped: 0, awaitingRelease: 2, toDo: 0 }, forecast: landed, next: null, delivery: { ...stamp, landing: landed, release: approval, inHands: null, shipped: null } };

describe("what a requirement's act changes", () => {
  it("says under the banner what pressing the act does", () => {
    const standing = {
      state: "agreed",
      attentionGroup: "needs_you",
      waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.updateToDesign", { design: "Order handling", r: 4 }), rule: RULE, effect: say("standing.effect.follow", { names: [say("standing.effect.designAt", { title: "Order handling", r: 4 })] }) }),
    };
    render(<RequirementBanner standing={standing as never} />);
    expect(within(screen.getByTestId("wait-banner")).getByTestId("wait-effect")).toHaveTextContent("Records that this requirement follows Order handling revision 4 from now on.");
  });

  it("draws no effect line where core gave none", () => {
    const standing = { state: "agreed", attentionGroup: "needs_you", waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.agreeR", { r: 2 }), rule: RULE }) };
    render(<RequirementBanner standing={standing as never} />);
    expect(screen.queryByTestId("wait-effect")).toBeNull();
  });
});

describe("a requirement on a phone", () => {
  it("puts its progress and forecast in the main column, shown only below 640px, and takes them out of the rail's phone view", () => {
    render(<RequirementPhoneProgress state="in_delivery" passing={7} criteria={11} scope={scope} slug="hop" />);
    const block = screen.getByTestId("phone-progress");
    expect(block.className).toMatch(/\bhidden\b/);
    expect(block.className).toMatch(/max-sm:block/);
    expect(within(block).getByTestId("criteria-rest-line").textContent).toContain("7 of 11 criteria proven");
    expect(within(block).getByTestId("step-bar")).toBeInTheDocument();
  });
});
