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
  it("prefers the label a person typed", () => {
    expect(agentLabel({ ...AGENT, displayName: "Ops on call" })).toBe("Ops on call");
  });

  it("falls back to the handle when no label has been typed", () => {
    expect(agentLabel(AGENT)).toBe("forge-dev");
  });

  it("treats a blank label as no label", () => {
    expect(agentLabel({ ...AGENT, displayName: "   " })).toBe("forge-dev");
  });

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

  it("does not tell an agent that already holds a credential to mint another", () => {
    const reach = reachOf({ canAct: false, projectId: "", activeTokens: 2 });
    expect(reach).toMatchObject({ why: "belongs to no project" });
    const remedy = (reach as { remedy: string }).remedy;
    expect(remedy).toContain("Add it to a project");
    expect(remedy).not.toContain("give it a credential");
  });
});
