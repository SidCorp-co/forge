// A demo web answers /api as its seeded member on the server: the browser holds no cookie, so a
// frame on another site (no third-party cookies in Safari, no SameSite=Lax in Chrome) is signed in.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CORE = "http://127.0.0.1:9";
const jwt = (expSeconds: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function demoCore(token: string) {
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": `forge_auth=${token}; Path=/; HttpOnly` },
  });
}

function request(path: string, cookie = "forge_auth=browser-own; other=1") {
  return new NextRequest(`http://web.test${path}`, { headers: { cookie } });
}

let asked: string[];
beforeEach(() => {
  vi.resetModules();
  asked = [];
  vi.stubEnv("FORGE_DEMO_SIGNIN", "1");
  vi.stubEnv("E2E_CORE_PROXY_URL", CORE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function load() {
  return import("./demo-signin");
}

describe("demoApi", () => {
  it("is not a demo web unless FORGE_DEMO_SIGNIN is 1: it answers nothing and asks no core", async () => {
    vi.stubEnv("FORGE_DEMO_SIGNIN", "");
    vi.stubGlobal("fetch", vi.fn(async () => demoCore("x")));
    expect(await (await load()).demoApi(request("/api/projects"))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends /api on to the demo core as the demo member, never with the browser's cookie", async () => {
    const token = jwt(inAnHour());
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(String(url));
      return demoCore(token);
    }));
    const res = await (await load()).demoApi(request("/api/projects?x=1"));
    expect(res?.headers.get("x-middleware-rewrite")).toBe(`${CORE}/api/projects?x=1`);
    expect(res?.headers.get("x-middleware-request-cookie")).toBe(`forge_auth=${token}`);
    expect(asked).toEqual([`${CORE}/api/auth/demo`]);
  });

  it("asks the core once for as long as the credential lasts, and again when it is about to end", async () => {
    const { demoApi } = await load();
    vi.stubGlobal("fetch", vi.fn(async () => {
      asked.push("ask");
      return demoCore(jwt(inAnHour()));
    }));
    await demoApi(request("/api/a"));
    await demoApi(request("/api/b"));
    expect(asked).toHaveLength(1);

    vi.resetModules();
    asked = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      asked.push("ask");
      return demoCore(jwt(Math.floor(Date.now() / 1000) + 30));
    }));
    const again = await load();
    await again.demoApi(request("/api/a"));
    await again.demoApi(request("/api/b"));
    expect(asked).toHaveLength(2);
  });

  it("refuses a browser's own request for the sign-in by name", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await (await load()).demoApi(request("/api/auth/demo"));
    expect(res?.status).toBe(404);
    expect((await res?.json())?.code).toBe("DEMO_SIGNIN_IS_SERVER_SIDE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses by name, and holds nothing, when the core is not a demo core", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      asked.push("ask");
      return new Response('{"code":"DEMO_MODE_OFF"}', { status: 404 });
    }));
    const { demoApi } = await load();
    const res = await demoApi(request("/api/projects"));
    expect(res?.status).toBe(502);
    const body = await res?.json();
    expect(body?.code).toBe("DEMO_SIGNIN_REFUSED");
    expect(body?.message).toContain("FORGE_DEMO_MODE=1");
    expect(res?.headers.get("x-middleware-rewrite")).toBeNull();
    await demoApi(request("/api/projects"));
    expect(asked).toHaveLength(2);
  });

  it("refuses by name when the core cannot be reached, and when it is not named", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const { demoApi } = await load();
    const down = await demoApi(request("/api/projects"));
    expect(down?.status).toBe(502);
    expect((await down?.json())?.code).toBe("DEMO_CORE_UNREACHABLE");
    vi.stubEnv("E2E_CORE_PROXY_URL", "");
    const unset = await demoApi(request("/api/projects"));
    expect(unset?.status).toBe(500);
    expect((await unset?.json())?.code).toBe("DEMO_CORE_UNSET");
  });
});

describe("demoRequest", () => {
  it("carries the demo member's credential on a page-level gate's request, and leaves any other web's alone", async () => {
    const token = jwt(inAnHour());
    vi.stubGlobal("fetch", vi.fn(async () => demoCore(token)));
    const { demoRequest } = await load();
    expect((await demoRequest(request("/admin"))).headers.get("cookie")).toBe(`forge_auth=${token}`);
    vi.stubEnv("FORGE_DEMO_SIGNIN", "");
    const plain = request("/admin");
    expect(await demoRequest(plain)).toBe(plain);
  });
});
