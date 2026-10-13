// ISS-1166: what the screen says of a token follows what the server does with it. "Can reach the
// account" is `auth/pat-live.ts:patIsLive` (unrevoked and unexpired), and the assistant's per-turn
// credentials are recognised by the name `assistant/tools/forge-cli.ts:runForgeCli` writes.

import { describe, expect, it } from "vitest";
import { chatTurnLine, endOf, endedLine, groupTokens, originOf, reachStatement } from "./token-view";
import type { PatToken } from "./types";

const NOW = Date.parse("2026-10-14T00:00:00Z");

function token(over: Partial<PatToken>): PatToken {
  return {
    id: over.name ?? "t",
    name: "a token",
    prefix: "forge_pat_x",
    scopes: ["read"],
    projectIds: null,
    permissions: null,
    grant: "legacy",
    boundProjectId: null,
    expiresAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    ...over,
  };
}

const chat = (n: number, over: Partial<PatToken> = {}) =>
  token({ name: `chat turn 2026-09-17T09:57:56.421Z ${n.toString(16).padStart(8, "0")}`, ...over });

describe("endOf: the server's own test of whether a token is live", () => {
  it("calls an unrevoked token with no expiry live", () => {
    expect(endOf(token({}), NOW)).toBeNull();
  });

  it("calls a token revoked when it was revoked", () => {
    expect(endOf(token({ revokedAt: "2026-09-02T00:00:00Z" }), NOW)).toEqual({ kind: "revoked", at: "2026-09-02T00:00:00Z" });
  });

  it("calls an unrevoked token past its expiry expired, and one expiring in the future live", () => {
    expect(endOf(token({ expiresAt: "2026-10-01T00:00:00Z" }), NOW)?.kind).toBe("expired");
    expect(endOf(token({ expiresAt: "2026-11-01T00:00:00Z" }), NOW)).toBeNull();
  });

  it("ends a token expiring this very instant, as the server's strict greater-than does", () => {
    expect(endOf(token({ expiresAt: new Date(NOW).toISOString() }), NOW)?.kind).toBe("expired");
  });

  it("says revoked for a token that was both revoked and past its expiry", () => {
    const t = token({ revokedAt: "2026-09-02T00:00:00Z", expiresAt: "2026-09-03T00:00:00Z" });
    expect(endOf(t, NOW)?.kind).toBe("revoked");
  });
});

describe("originOf: who made a token, read from the name its minter wrote", () => {
  it("reads the assistant's per-turn name, and a box's device and workspace names", () => {
    expect(originOf(chat(1))).toBe("chat-turn");
    expect(originOf({ name: "device:6f1c" })).toBe("box");
    expect(originOf({ name: "workspace:6f1c:7dca" })).toBe("box");
  });

  it("takes any other name for one a person typed, including one that only begins like a chat turn", () => {
    expect(originOf({ name: "CI deploy token" })).toBe("you");
    expect(originOf({ name: "chat turn notes" })).toBe("you");
    expect(originOf({ name: "chat turn 2026-09-17T09:57:56.421Z" })).toBe("you");
  });
});

describe("groupTokens: 43 tokens, 41 of them revoked and 38 of those the assistant's", () => {
  const revokedChat = Array.from({ length: 38 }, (_, i) => chat(i, { revokedAt: "2026-09-17T10:00:00Z" }));
  const revokedOwn = [
    token({ name: "old-1", revokedAt: "2026-09-02T00:00:00Z" }),
    token({ name: "old-2", revokedAt: "2026-09-03T00:00:00Z" }),
    token({ name: "old-3", expiresAt: "2026-09-04T00:00:00Z" }),
  ];
  const live = [token({ name: "iss974-walk-2" }), token({ name: "iss974-walk-admin" })];
  const groups = groupTokens([...revokedChat, ...revokedOwn, ...live], NOW);

  it("lists the two live tokens and counts the two as reaching the account", () => {
    expect(groups.live.map((t) => t.name)).toEqual(["iss974-walk-2", "iss974-walk-admin"]);
    expect(groups.reaching).toBe(2);
  });

  it("puts the three ended tokens a person made behind the line, and none of the assistant's", () => {
    expect(groups.ended.map((t) => t.name)).toEqual(["old-1", "old-2", "old-3"]);
  });

  it("summarises the assistant's 38 and says none is live", () => {
    expect(groups.chatTurn).toEqual({ total: 38, live: 0 });
  });

  it("counts a live chat-turn credential among those that reach the account, without listing it", () => {
    const g = groupTokens([chat(1), ...live], NOW);
    expect(g.reaching).toBe(3);
    expect(g.live).toHaveLength(2);
    expect(g.chatTurn).toEqual({ total: 1, live: 1 });
  });
});

describe("the words", () => {
  it("states the count, in the singular and the plural, and when there is none", () => {
    expect(reachStatement(2)).toBe("2 tokens can reach your account.");
    expect(reachStatement(1)).toBe("1 token can reach your account.");
    expect(reachStatement(0)).toBe("No token can reach your account.");
  });

  it("carries the number on the line the ended tokens sit behind", () => {
    expect(endedLine(3)).toBe("3 tokens no longer reach your account (revoked or expired)");
    expect(endedLine(1)).toBe("1 token no longer reaches your account (revoked or expired)");
  });

  it("says how many chat-turn credentials exist and how many are live, and how each ends", () => {
    expect(chatTurnLine({ total: 38, live: 0 })).toMatch(/^38 credentials .*none are live\./);
    expect(chatTurnLine({ total: 38, live: 1 })).toMatch(/1 is live/);
    expect(chatTurnLine({ total: 38, live: 0 })).toMatch(/revoked when its turn ends, and otherwise expires within ten minutes/);
    expect(chatTurnLine({ total: 0, live: 0 })).toBeNull();
  });
});
