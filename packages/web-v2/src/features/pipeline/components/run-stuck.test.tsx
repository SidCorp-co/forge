import type { ItemStanding } from "@forge/contracts/steward";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { say, verbatim, waitingOn } from "@/test/said";
import { RunStuck } from "./run-stuck";

// @direct-test-of packages/web-v2/src/features/standing/hooks.ts
// ISS-684 (REQ-74 BC-5): a stuck run's detail names why its issue is stuck and the agent that acts.

const AT = "2026-10-07T08:00:00.000Z";

const STUCK: ItemStanding = {
  subject: { kind: "issue", id: "i1", key: "ISS-7" },
  title: "Seventh",
  group: "stuck",
  waitingOn: waitingOn("master", { who: say("standing.who.master"), act: say("overview.hold.act.nextPass"), rule: verbatim("r") }),
  note: null,
  actClass: "master_take",
  since: AT,
  dueAt: null,
  stuck: { code: "no_owner", since: AT, reason: "x", via: null, says: { reason: say("standing.stuck.noOwner") } },
  carriedBy: null,
  basis: "b",
};

describe("a stuck run's detail", () => {
  const seeded = () => renderWithQuery(<RunStuck projectId="p1" issueKey="ISS-7" />);

  it("names why its issue is stuck and the agent that acts on it", async () => {
    const { client } = seeded();
    client.setQueryData(["issues", "standing", "steward", "standings", "p1"], { standings: [STUCK] });
    const box = await screen.findByTestId("run-stuck");
    expect(box.textContent).toContain("Nobody owns it, so nobody moves it on.");
    expect(box.textContent).toContain("Master");
    expect(box.textContent).toContain("decide what follows on its next pass");
  });

  it("draws nothing for a run whose issue is not stuck", async () => {
    const { client } = seeded();
    client.setQueryData(["issues", "standing", "steward", "standings", "p1"], { standings: [{ ...STUCK, stuck: null }] });
    await Promise.resolve();
    expect(screen.queryByTestId("run-stuck")).toBeNull();
  });
});
