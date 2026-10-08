import type { ConnectionDirectoryItem } from "@forge/contracts";
import { describe, expect, it } from "vitest";
import { connectionInSpace, connectionOwnerLabel, readOnlyNote } from "./connection-space";

const TEAM = { id: "org-team", isPersonal: false };
const PERSONAL = { id: "org-me", isPersonal: true };
const PROJECT_IN_TEAM = "project-in-team";
const projectOrg = (id: string) => (id === PROJECT_IN_TEAM ? TEAM.id : "org-elsewhere");

function item(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "c1",
    ownerType: "user",
    ownerId: "someone-else",
    provider: "github",
    displayName: "GitHub App",
    config: {},
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    usage: { bindings: [] },
    access: { reach: "binding", canManage: false },
    ...over,
  };
}

const boundTo = (projectId: string) => ({
  bindings: [
    { id: "b1", projectId, role: "service" as const, stages: [], label: "", active: true },
  ],
});

describe("which space a connection belongs in", () => {
  it("lists the caller's own credential in their personal space", () => {
    const own = item({ access: { reach: "owner", canManage: true } });
    expect(connectionInSpace(own, PERSONAL, projectOrg)).toBe(true);
  });

  it("never lists somebody else's credential, reached through a binding, as the caller's own", () => {
    const theirs = item({ usage: boundTo(PROJECT_IN_TEAM) });
    expect(connectionInSpace(theirs, PERSONAL, projectOrg)).toBe(false);
  });

  it("lists a credential another person minted in the team space whose project binds it", () => {
    const theirs = item({ usage: boundTo(PROJECT_IN_TEAM) });
    expect(connectionInSpace(theirs, TEAM, projectOrg)).toBe(true);
  });

  it("does not list it in a team space none of whose projects bind it", () => {
    const theirs = item({ usage: boundTo("project-elsewhere") });
    expect(connectionInSpace(theirs, TEAM, projectOrg)).toBe(false);
  });

  it("still lists what the team owns, bound or not", () => {
    const owned = item({
      ownerType: "org",
      ownerId: TEAM.id,
      access: { reach: "org", canManage: false },
    });
    expect(connectionInSpace(owned, TEAM, projectOrg)).toBe(true);
  });

  it("does not move the caller's own credential into a team space because a team project uses it", () => {
    const own = item({ access: { reach: "owner", canManage: true }, usage: boundTo(PROJECT_IN_TEAM) });
    expect(connectionInSpace(own, TEAM, projectOrg)).toBe(false);
  });

  it("lists everything while no space is chosen", () => {
    expect(connectionInSpace(item(), null, projectOrg)).toBe(true);
  });
});

describe("how a row names its owner and why it is read-only", () => {
  it("calls another person's credential another user's, not Personal", () => {
    expect(connectionOwnerLabel(item(), () => undefined)).toBe("Another user");
    expect(
      connectionOwnerLabel(item({ access: { reach: "owner", canManage: true } }), () => undefined),
    ).toBe("Personal");
  });

  it("names the org, falling back to a generic word for one the caller cannot name", () => {
    const owned = item({ ownerType: "org", ownerId: "o1", access: { reach: "org", canManage: false } });
    expect(connectionOwnerLabel(owned, () => "Sidcorp")).toBe("Sidcorp");
    expect(connectionOwnerLabel(owned, () => undefined)).toBe("Organization");
  });

  it("says who may change it", () => {
    expect(readOnlyNote(item(), "Another user")).toMatch(/only its owner/);
    const owned = item({ ownerType: "org", ownerId: "o1" });
    expect(readOnlyNote(owned, "Sidcorp")).toMatch(/owner or admin of Sidcorp/);
  });
});
