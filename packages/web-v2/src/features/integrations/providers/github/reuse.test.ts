import type { ConnectionDirectoryItem } from "@forge/contracts";
import { describe, expect, it } from "vitest";
import { bindableApps, canBindHere, unbindableReason } from "./reuse";

const PROJECT = { orgId: "org-b", orgName: "Beta" };

function app(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "c1",
    ownerType: "org",
    ownerId: "org-b",
    provider: "github",
    displayName: "Forge App",
    config: {},
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    usage: { bindings: [] },
    access: { reach: "org", canManage: true },
    ...over,
  };
}

describe("which GitHub App a project is offered", () => {
  it("offers an App its own org owns and the caller can manage", () => {
    expect(bindableApps([app()], PROJECT)).toHaveLength(1);
  });

  it("skips a manageable App owned by a different org, which the bind route would refuse with ORG_MISMATCH, and picks the compatible one after it", () => {
    const incompatible = app({ id: "org-a-app", ownerId: "org-a" });
    const compatible = app({ id: "org-b-app" });

    const offered = bindableApps([incompatible, compatible], PROJECT);

    expect(offered.map((c) => c.id)).toEqual(["org-b-app"]);
  });

  it("offers the caller's own personal App to any project", () => {
    const mine = app({ ownerType: "user", ownerId: "me", access: { reach: "owner", canManage: true } });
    expect(canBindHere(mine, PROJECT)).toBe(true);
  });

  it("does not offer an App the caller can read but not manage", () => {
    const theirs = app({ ownerType: "user", ownerId: "them", access: { reach: "binding", canManage: false } });
    expect(bindableApps([theirs], PROJECT)).toEqual([]);
  });

  it("does not offer a disabled App or another provider's connection", () => {
    expect(bindableApps([app({ active: false }), app({ provider: "coolify" })], PROJECT)).toEqual([]);
  });
});

describe("what a project is told when it cannot bind the App it can see", () => {
  it("names the owner and who can bind it, for another user's App", () => {
    const theirs = app({ ownerType: "user", ownerId: "them", access: { reach: "binding", canManage: false } });

    const reason = unbindableReason([theirs], PROJECT);

    expect(reason).toContain("Forge App");
    expect(reason).toMatch(/owned by another user, and only its owner can bind it/);
  });

  it("names the org when the org is the project's own and the caller is not an admin of it", () => {
    const owned = app({ access: { reach: "org", canManage: false } });

    expect(unbindableReason([owned], PROJECT)).toMatch(/owned by Beta, and only an owner or admin of it can bind it/);
  });

  it("says a manageable App of another org belongs elsewhere", () => {
    expect(unbindableReason([app({ ownerId: "org-a" })], PROJECT)).toMatch(/different organization/);
  });

  it("says nothing when an App can be bound, or when none is reachable", () => {
    expect(unbindableReason([app()], PROJECT)).toBeNull();
    expect(unbindableReason([], PROJECT)).toBeNull();
  });
});
