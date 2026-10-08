// A BA reads what an act changes before pressing it, in the strip at the top of the requirement.

import { RULE, say, waitingOn } from "@/test/said";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequirementProgress } from "./standing-bits";

describe("what a requirement's act changes", () => {
  it("says under the banner what pressing the act does", () => {
    const standing = {
      state: "agreed",
      attentionGroup: "needs_you",
      coverage: [],
      waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.updateToDesign", { design: "Order handling", r: 4 }), rule: RULE, effect: say("standing.effect.follow", { names: [say("standing.effect.designAt", { title: "Order handling", r: 4 })] }) }),
    };
    render(<RequirementProgress standing={standing as never} inset="px-4" />);
    expect(within(screen.getByTestId("wait-banner")).getByTestId("wait-effect")).toHaveTextContent("Records that this requirement follows Order handling revision 4 from now on.");
  });

  it("draws no effect line where core gave none", () => {
    const standing = { state: "agreed", attentionGroup: "needs_you", coverage: [], waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.agreeR", { r: 2 }), rule: RULE }) };
    render(<RequirementProgress standing={standing as never} inset="px-4" />);
    expect(screen.queryByTestId("wait-effect")).toBeNull();
  });
});
