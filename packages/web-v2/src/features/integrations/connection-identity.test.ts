// A card that cannot tell two credentials apart is a card that lies by
// omission: seventeen Coolify rows on forge-beta rendered identically because
// the only thing shown was the provider. These are the three signals that
// separate them.

import { describe, expect, it } from "vitest";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { connectionTarget, connectionTitle, matchesQuery } from "./connection-identity";

function conn(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "conn-1",
    ownerType: "user",
    ownerId: "user-1",
    provider: "coolify",
    displayName: null,
    config: {},
    active: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    usage: { bindings: [] },
    ...over,
  } as ConnectionDirectoryItem;
}

const NAMES: Record<string, string> = { "proj-a": "forge-dev", "proj-b": "getcontent" };
const projectName = (id: string) => NAMES[id] ?? id;

describe("connectionTitle", () => {
  it("prefers the name its owner gave it", () => {
    expect(connectionTitle(conn({ displayName: "Prod deploy token" }))).toBe("Prod deploy token");
  });

  it("falls back to the provider label rather than showing an empty card", () => {
    expect(connectionTitle(conn())).toBe("Coolify deploy");
  });

  it("shows an unknown provider by its raw key rather than blank", () => {
    expect(connectionTitle(conn({ provider: "newthing" as never }))).toBe("newthing");
  });
});

describe("connectionTarget", () => {
  it("reduces a base URL to the host that identifies it", () => {
    expect(connectionTarget(conn({ config: { baseUrl: "https://deploy.example.com/api/v1" } }))).toBe(
      "deploy.example.com",
    );
  });

  it("names a GitHub connection by the repository, which is what distinguishes it", () => {
    expect(
      connectionTarget(conn({ provider: "github", config: { owner: "SidCorp-co", repo: "forge" } })),
    ).toBe("SidCorp-co/forge");
  });

  it("returns null rather than a blank line when the config identifies nothing", () => {
    expect(connectionTarget(conn())).toBeNull();
    expect(connectionTarget(conn({ config: { baseUrl: "://broken" } }))).toBeNull();
  });
});

describe("matchesQuery", () => {
  const item = conn({
    displayName: "Prod deploy token",
    config: { baseUrl: "https://deploy.example.com" },
    usage: {
      bindings: [
        { id: "b1", projectId: "proj-a", environment: "prod", label: "", active: true },
      ],
    },
  });

  it("keeps everything when the query is blank", () => {
    expect(matchesQuery(item, "   ", projectName)).toBe(true);
  });

  it("finds a credential by the PROJECT that uses it, which is how operators look it up", () => {
    expect(matchesQuery(item, "forge-dev", projectName)).toBe(true);
    expect(matchesQuery(item, "getcontent", projectName)).toBe(false);
  });

  it("finds it by name, endpoint and provider label alike", () => {
    expect(matchesQuery(item, "PROD DEPLOY", projectName)).toBe(true);
    expect(matchesQuery(item, "example.com", projectName)).toBe(true);
    expect(matchesQuery(item, "coolify", projectName)).toBe(true);
  });

  it("excludes what does not match, rather than degrading to show-all", () => {
    expect(matchesQuery(item, "sentry", projectName)).toBe(false);
  });
});
