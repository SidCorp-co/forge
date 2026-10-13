// ISS-1169: an identifier is never a display value, and the advice for an agent that cannot act is
// the same for every agent, so it is not part of what one agent's reach says.

import { describe, expect, it } from "vitest";
import { agentProjectNames, reachOf } from "./label";

const agent = (ids: string[]) => ({ projects: ids.map((id) => ({ id, role: "member" })) });
const names: Record<string, string> = { p1: "alpha", p2: "bravo" };
const nameOf = (id: string) => names[id];

describe("agentProjectNames", () => {
  it("lists the projects it can name, in the agent's order", () => {
    expect(agentProjectNames(agent(["p2", "p1"]), nameOf)).toBe("bravo, alpha");
  });

  it("says none for an agent in no project", () => {
    expect(agentProjectNames(agent([]), nameOf)).toBe("none");
  });

  it("never prints the id of a project it cannot resolve, and says the project was removed or is not shared", () => {
    const text = agentProjectNames(agent(["p1", "7dca1ad6-ab90-443f-a188-98f3e770265b"]), nameOf);
    expect(text).toBe("alpha, 1 project removed or not shared with you");
    expect(text).not.toContain("7dca1ad6");
  });

  it("counts several unresolved projects instead of listing their ids", () => {
    expect(agentProjectNames(agent(["x", "y"]), nameOf)).toBe("2 projects removed or not shared with you");
  });

  it("says the projects are loading while the names are not known, rather than calling every project removed", () => {
    expect(agentProjectNames(agent(["p1"]), () => undefined, true)).toBe("Loading projects…");
  });
});

describe("reachOf", () => {
  it("is a plain yes for an agent that can act", () => {
    expect(reachOf({ canAct: true, projects: [] })).toEqual({ canAct: true });
  });

  it("gives only the reason an agent cannot act, with no advice to repeat", () => {
    expect(reachOf({ canAct: false, projects: [] })).toEqual({ canAct: false, why: "belongs to no project" });
    expect(reachOf({ canAct: false, projects: [{ id: "p1", role: "member" }] })).toEqual({
      canAct: false,
      why: "holds no live credential",
    });
  });
});
