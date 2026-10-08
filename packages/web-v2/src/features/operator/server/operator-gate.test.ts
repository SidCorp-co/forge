// The /admin gate hands core every forge_auth value the web host was sent and lets core decide.
// A framework cookie jar keeps one value per name, so a sibling instance's parent-domain cookie
// (forge-beta, Domain=.sidcorp.co) sent ahead of this host's own used to be the only one core saw.

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorGate } from "./operator-gate";
import { authCookieHeader } from "./whoami-fetch";

afterEach(() => vi.unstubAllGlobals());

const JUNK = "junk-parent-domain-value";
const VALID = "valid-host-value";

/** A core that opens a session only for VALID, trying every forge_auth value in order. */
function stubCore() {
  const seen: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const cookie = new Headers(init?.headers).get("cookie");
    seen.push(cookie);
    const values = (cookie ?? "").split(";").map((p) => p.trim().slice("forge_auth=".length));
    return values.includes(VALID)
      ? Response.json({ isAdmin: true, email: "op@forge.test" })
      : Response.json({ error: { code: "SESSION_EXPIRED", message: "x" } }, { status: 401 });
  });
  return seen;
}

function adminRequest(cookie?: string) {
  return new NextRequest("https://forge-dev.example.test/admin", {
    headers: cookie ? { cookie } : {},
  });
}

describe("authCookieHeader", () => {
  it("keeps every forge_auth value in order and drops other cookies", () => {
    expect(authCookieHeader(`a=1; forge_auth=${JUNK}; other=2; forge_auth=${VALID}`)).toBe(
      `forge_auth=${JUNK}; forge_auth=${VALID}`,
    );
  });
  it("is null with none, or only empty ones", () => {
    expect(authCookieHeader("a=1")).toBeNull();
    expect(authCookieHeader("forge_auth=")).toBeNull();
    expect(authCookieHeader(null)).toBeNull();
  });
});

describe("operatorGate", () => {
  it("passes a request carrying a junk value first and a valid one second", async () => {
    const seen = stubCore();
    const res = await operatorGate(adminRequest(`forge_auth=${JUNK}; forge_auth=${VALID}`));
    expect(res.headers.get("location")).toBeNull();
    expect(seen).toEqual([`forge_auth=${JUNK}; forge_auth=${VALID}`]);
  });

  it("sends a single junk value to /login with the session-ended marker", async () => {
    stubCore();
    const res = await operatorGate(adminRequest(`forge_auth=${JUNK}`));
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(to.search).toBe("?session=ended");
  });

  it("renders for the browser to ask core when the web host sees no forge_auth at all", async () => {
    const seen = stubCore();
    const res = await operatorGate(adminRequest("theme=dark"));
    expect(res.headers.get("location")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("sends a non-admin to /", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isAdmin: false, email: "a@b.test" }));
    const res = await operatorGate(adminRequest(`forge_auth=${VALID}`));
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/");
  });
});
