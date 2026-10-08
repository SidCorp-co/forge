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
    access: { reach: "org", canManage: true, ownerName: null },
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
    const mine = app({ ownerType: "user", ownerId: "me", access: { reach: "owner", canManage: true, ownerName: null } });
    expect(canBindHere(mine, PROJECT)).toBe(true);
  });

  it("does not offer an App the caller can read but not manage", () => {
    const theirs = app({ ownerType: "user", ownerId: "them", access: { reach: "binding", canManage: false, ownerName: null } });
    expect(bindableApps([theirs], PROJECT)).toEqual([]);
  });

  it("does not offer a disabled App or another provider's connection", () => {
    expect(bindableApps([app({ active: false }), app({ provider: "coolify" })], PROJECT)).toEqual([]);
  });
});

describe("what a project is told when it cannot bind the App it can see", () => {
  it("names the person who owns another user's App and says only they can bind it", () => {
    const theirs = app({
      ownerType: "user",
      ownerId: "them",
      access: { reach: "binding", canManage: false, ownerName: "Dana Reyes" },
    });

    const reason = unbindableReason([theirs], PROJECT);

    expect(reason).toContain("Forge App");
    expect(reason).toMatch(/owned by Dana Reyes, and only they can bind it/);
    expect(reason).toMatch(/ask Dana Reyes/);
  });

  it("falls back to its owner where the owner no longer resolves, never to a made-up name", () => {
    const theirs = app({
      ownerType: "user",
      ownerId: "gone",
      access: { reach: "binding", canManage: false, ownerName: null },
    });

    expect(unbindableReason([theirs], PROJECT)).toMatch(/owned by another user, and only its owner can bind it/);
  });

  it("names the org when the org is the project's own and the caller is not an admin of it", () => {
    const owned = app({ access: { reach: "org", canManage: false, ownerName: "Beta" } });

    expect(unbindableReason([owned], PROJECT)).toMatch(
      /owned by Beta, and only an owner or admin of Beta can bind it to this project/,
    );
  });

  it("names the other organization and who can use the App, for an App reached through a project of another org", () => {
    const elsewhere = app({
      ownerId: "org-a",
      access: { reach: "binding", canManage: false, ownerName: "Acme" },
    });

    const reason = unbindableReason([elsewhere], PROJECT) ?? "";

    expect(reason).toMatch(/owned by the organization Acme/);
    expect(reason).toMatch(/only a project in it can use it/);
    expect(reason).toMatch(/owner or admin of Acme can use it from there/);
    expect(reason).not.toMatch(/already serves this workspace/);
  });

  it("says nothing when an App can be bound, or when none is reachable", () => {
    expect(unbindableReason([app()], PROJECT)).toBeNull();
    expect(unbindableReason([], PROJECT)).toBeNull();
  });
});
