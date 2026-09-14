import { describe, expect, it } from "vitest";
import { agentAddress, agentLabel, reachOf } from "./label";

const AGENT = {
  displayName: null as string | null,
  handle: "forge-dev",
  email: "forge-dev.a1b2c3d4e5f6@agents.forge.invalid",
  canAct: true,
  projectId: "p1",
  activeTokens: 1,
};

describe("what a person reads for an agent (ISS-1003)", () => {
  // cm:guard this file asserts the ORDER of the fallback and nothing about the alphabet, deliberately: agentLabel picks between three strings and folds none of them, so an accented fixture here would prove nothing agentLabel could get wrong. Whether the column and the routes carry an accented label unchanged is asserted where a fixture may be non-English at all — packages/core/tests/integration/agent-accounts-e2e.test.ts sets and reads back a Vietnamese one, and this source tree is English-only by policy.
  it("prefers the label a person typed", () => {
    expect(agentLabel({ ...AGENT, displayName: "Ops on call" })).toBe("Ops on call");
  });

  it("falls back to the handle when no label has been typed", () => {
    expect(agentLabel(AGENT)).toBe("forge-dev");
  });

  // cm:guard whitespace is not a name. A label of spaces would otherwise win the chain and render as an empty cell, which reads as a bug in the list rather than as an agent nobody has named.
  it("treats a blank label as no label", () => {
    expect(agentLabel({ ...AGENT, displayName: "   " })).toBe("forge-dev");
  });

  // cm:guard the synthesized address is the LAST resort and never the first. Printing it is the defect ISS-1003 exists to remove: it carries a random suffix, so two people reading the same agent read different strings depending on which screen they are on.
  it("reaches the synthesized address only when nothing else is there", () => {
    expect(agentLabel({ ...AGENT, handle: "" })).toBe(AGENT.email);
  });

  it("prints the address as it is typed", () => {
    expect(agentAddress(AGENT)).toBe("@forge-dev");
    expect(agentAddress({ handle: "" })).toBe("—");
  });
});

describe("whether an agent can act", () => {
  it("says nothing more when it can", () => {
    expect(reachOf(AGENT)).toEqual({ canAct: true });
  });

  // cm:guard the remedy is asserted, not just the badge: this row is the population the screen was built for — a handle minted into a room with no token — and a state with no next step is how it stayed unnoticed.
  it("names a remedy when it holds no credential", () => {
    const reach = reachOf({ ...AGENT, canAct: false });
    expect(reach.canAct).toBe(false);
    expect(reach).toMatchObject({ why: "holds no live credential" });
    expect((reach as { remedy: string }).remedy).toContain("credential");
  });

  it("names the different remedy when it belongs to no project", () => {
    const reach = reachOf({ canAct: false, projectId: "", activeTokens: 0 });
    expect(reach).toMatchObject({ why: "belongs to no project" });
    expect((reach as { remedy: string }).remedy).toContain("give it a credential");
  });

  // cm:guard the two project-less rows are NOT one row: an agent that already holds a credential is told to add a project and nothing else, because minting it a second one changes nothing — the token is fenced to a project and the fence resolves to nothing. Collapsed into one message, the screen sends an admin to mint credentials that cannot help, which is the wasted next step this remedy exists to replace.
  it("does not tell an agent that already holds a credential to mint another", () => {
    const reach = reachOf({ canAct: false, projectId: "", activeTokens: 2 });
    expect(reach).toMatchObject({ why: "belongs to no project" });
    const remedy = (reach as { remedy: string }).remedy;
    expect(remedy).toContain("Add it to a project");
    expect(remedy).not.toContain("give it a credential");
  });
});
