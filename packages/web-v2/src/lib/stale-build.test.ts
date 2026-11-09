import { describe, expect, it, vi } from "vitest";
import { reloadForStaleBuild, reloadOnStaleBuild } from "./stale-build";

function memory() {
  const held = new Map<string, string>();
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
  };
}

describe("a stale build's failed import", () => {
  it("reloads the page once", () => {
    const reload = vi.fn();
    const storage = memory();
    expect(reloadForStaleBuild({ now: () => 1_000, reload, storage })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload again within a minute, so a real outage still shows", () => {
    const reload = vi.fn();
    const storage = memory();
    reloadForStaleBuild({ now: () => 1_000, reload, storage });
    expect(reloadForStaleBuild({ now: () => 50_000, reload, storage })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the minute has passed", () => {
    const reload = vi.fn();
    const storage = memory();
    reloadForStaleBuild({ now: () => 1_000, reload, storage });
    expect(reloadForStaleBuild({ now: () => 62_000, reload, storage })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reloads where storage refuses to be read", () => {
    const reload = vi.fn();
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(reloadForStaleBuild({ now: () => 1_000, reload, storage })).toBe(true);
  });

  it("is wired to vite:preloadError on the window, and keeps the error from throwing when it reloads", () => {
    const target = new EventTarget() as unknown as Window;
    const reload = vi.fn();
    Object.assign(target, { location: { reload }, sessionStorage: memory() });
    reloadOnStaleBuild(target);
    const event = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    const again = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });
});
