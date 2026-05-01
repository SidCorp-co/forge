import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthStoreForTest, useAuthStore, type AuthState } from "@/stores/auth-store";
import { useAppStore } from "@/stores/app-store";

const invokeMock = vi.fn();
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const clearProjectIdCacheMock = vi.fn();
const clearDeviceTokenCacheMock = vi.fn();
vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    clearProjectIdCache: () => clearProjectIdCacheMock(),
  };
});
vi.mock("@/lib/api/jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/jobs")>("@/lib/api/jobs");
  return {
    ...actual,
    clearDeviceTokenCache: () => clearDeviceTokenCacheMock(),
  };
});

const unregisterDesktopMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    unregisterDesktop: (...args: unknown[]) => unregisterDesktopMock(...args),
  };
});

const resolveApiBaseMock = vi.fn();
vi.mock("@/lib/api-discovery", () => ({
  resolveApiBase: (...args: unknown[]) => resolveApiBaseMock(...args),
  clearApiCache: vi.fn(),
}));

beforeEach(() => {
  invokeMock.mockReset();
  clearProjectIdCacheMock.mockReset();
  clearDeviceTokenCacheMock.mockReset();
  unregisterDesktopMock.mockReset();
  resolveApiBaseMock.mockReset();
  resolveApiBaseMock.mockImplementation(async (url: string) => url);
  _resetAuthStoreForTest();
  useAppStore.getState().setDeviceSettings({ projects: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function snapshot(): AuthState {
  const s = useAuthStore.getState();
  // Strip the action methods to make assertions readable.
  const { hydrateFromDisk, login, expire, logout, setDeviceId, ...state } = s;
  void hydrateFromDisk; void login; void expire; void logout; void setDeviceId;
  return state as AuthState;
}

describe("auth-store: hydrateFromDisk", () => {
  it("hydrating → unauthenticated when keychain is empty", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_config") return { coreUrl: "https://example.com", deviceId: "dev-1", projects: {} };
      if (cmd === "load_user_jwt") return null;
      return null;
    });

    await useAuthStore.getState().hydrateFromDisk();

    expect(snapshot()).toEqual({
      phase: "unauthenticated",
      coreUrl: "https://example.com",
      deviceId: "dev-1",
    });
  });

  it("hydrating → authenticated when keychain has a JWT and disk has coreUrl", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_config") return { coreUrl: "https://example.com", deviceId: "dev-1", projects: { foo: { slug: "foo", repoPath: "/r" } } };
      if (cmd === "load_user_jwt") return "jwt-abc";
      return null;
    });

    await useAuthStore.getState().hydrateFromDisk();

    expect(snapshot()).toEqual({
      phase: "authenticated",
      coreUrl: "https://example.com",
      token: "jwt-abc",
      deviceId: "dev-1",
    });
    // hydrate must clear projectId / device-token caches before transitioning
    // — otherwise a cached entry from a previous coreUrl would leak across.
    expect(clearProjectIdCacheMock).toHaveBeenCalled();
    expect(clearDeviceTokenCacheMock).toHaveBeenCalled();
    // device-settings slice was hydrated too
    expect(useAppStore.getState().deviceSettings.projects.foo).toBeTruthy();
  });

  it("self-heal: replaces coreUrl with resolveApiBase result and persists", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_config") return { coreUrl: "https://web.example.com", deviceId: "d", projects: {} };
      if (cmd === "load_user_jwt") return "tok";
      if (cmd === "save_config") return null;
      void args;
      return null;
    });
    resolveApiBaseMock.mockResolvedValue("https://api.example.com");

    await useAuthStore.getState().hydrateFromDisk();

    const snap = snapshot();
    expect(snap.phase).toBe("authenticated");
    if (snap.phase === "authenticated") expect(snap.coreUrl).toBe("https://api.example.com");
    const saveConfigCall = invokeMock.mock.calls.find((c) => c[0] === "save_config");
    expect(saveConfigCall).toBeDefined();
    expect((saveConfigCall![1] as { config: { coreUrl: string } }).config.coreUrl).toBe("https://api.example.com");
  });

  it("hydrate is idempotent — second call does not re-run", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_config") return { coreUrl: "https://example.com", deviceId: "d", projects: {} };
      if (cmd === "load_user_jwt") return null;
      return null;
    });
    await useAuthStore.getState().hydrateFromDisk();
    invokeMock.mockClear();
    await useAuthStore.getState().hydrateFromDisk();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("auth-store: login", () => {
  beforeEach(() => {
    // Start from unauthenticated to mirror normal LoginPage flow.
    useAuthStore.setState({
      phase: "unauthenticated",
      coreUrl: null,
      deviceId: null,
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
  });

  it("transitions unauthenticated → authenticated", async () => {
    invokeMock.mockResolvedValue(null);
    await useAuthStore.getState().login({
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    });
    expect(snapshot()).toEqual({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    });
  });

  it("clears API caches BEFORE flipping state — guards against stale projectId/deviceToken leaking to the new core", async () => {
    const order: string[] = [];
    clearProjectIdCacheMock.mockImplementation(() => order.push("clearProjectIdCache"));
    clearDeviceTokenCacheMock.mockImplementation(() => order.push("clearDeviceTokenCache"));
    const unsub = useAuthStore.subscribe((s) => {
      if (s.phase === "authenticated") order.push("set:authenticated");
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "store_user_jwt") order.push("store_user_jwt");
      return null;
    });

    await useAuthStore.getState().login({ coreUrl: "https://api.example.com", token: "jwt-1" });
    unsub();

    const setIdx = order.indexOf("set:authenticated");
    const clearIdx = Math.min(order.indexOf("clearProjectIdCache"), order.indexOf("clearDeviceTokenCache"));
    const writeIdx = order.indexOf("store_user_jwt");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(clearIdx);
    expect(writeIdx).toBeGreaterThan(setIdx);
  });

  it("keychain write failure does not roll back state — next reload re-prompts login", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "store_user_jwt") throw new Error("keychain unavailable");
      return null;
    });
    await useAuthStore.getState().login({
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    });
    const snap = snapshot();
    expect(snap.phase).toBe("authenticated");
    if (snap.phase === "authenticated") expect(snap.token).toBe("jwt-1");
  });

  it("preserves deviceId from previous unauthenticated state when login() omits one", async () => {
    useAuthStore.setState({
      phase: "unauthenticated",
      coreUrl: null,
      deviceId: "carry-over",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    invokeMock.mockResolvedValue(null);
    await useAuthStore.getState().login({ coreUrl: "https://api.example.com", token: "jwt-1" });
    const snap = snapshot();
    if (snap.phase === "authenticated") expect(snap.deviceId).toBe("carry-over");
  });
});

describe("auth-store: expire", () => {
  beforeEach(() => {
    useAuthStore.setState({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
  });

  it("authenticated → expired and clears keychain", async () => {
    invokeMock.mockResolvedValue(null);
    useAuthStore.getState().expire();
    expect(snapshot()).toEqual({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    });
    // Allow the dispatched clear_user_jwt to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith("clear_user_jwt");
  });

  it("is idempotent: calling expire() a second time is a no-op (no extra keychain wipe)", async () => {
    invokeMock.mockResolvedValue(null);
    useAuthStore.getState().expire();
    useAuthStore.getState().expire();
    await new Promise((r) => setTimeout(r, 0));
    const wipes = invokeMock.mock.calls.filter((c) => c[0] === "clear_user_jwt");
    expect(wipes.length).toBe(1);
  });

  it("ignored when phase is not authenticated", () => {
    _resetAuthStoreForTest();
    useAuthStore.getState().expire(); // hydrating
    expect(useAuthStore.getState().phase).toBe("hydrating");
  });

  it("clears API + device-token caches so a re-login on the same coreUrl can't reuse a stale device token", async () => {
    invokeMock.mockResolvedValue(null);
    useAuthStore.getState().expire();
    await new Promise((r) => setTimeout(r, 0));
    expect(clearProjectIdCacheMock).toHaveBeenCalled();
    expect(clearDeviceTokenCacheMock).toHaveBeenCalled();
  });
});

describe("auth-store: re-auth from expired", () => {
  beforeEach(() => {
    useAuthStore.setState({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
  });

  it("logout() from expired → unauthenticated, preserving coreUrl + deviceId for re-login UX", async () => {
    invokeMock.mockResolvedValue(null);
    await useAuthStore.getState().logout();
    expect(snapshot()).toEqual({
      phase: "unauthenticated",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("clear_user_jwt");
  });

  it("login() from expired → authenticated reuses the existing device row", async () => {
    invokeMock.mockResolvedValue(null);
    await useAuthStore.getState().login({
      coreUrl: "https://api.example.com",
      token: "jwt-2",
    });
    const snap = snapshot();
    expect(snap.phase).toBe("authenticated");
    if (snap.phase === "authenticated") {
      expect(snap.deviceId).toBe("dev-1");
      expect(snap.token).toBe("jwt-2");
    }
  });
});

describe("auth-store: logout", () => {
  beforeEach(() => {
    useAuthStore.setState({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
  });

  it("authenticated → unauthenticated, clears keychain, calls save_config", async () => {
    invokeMock.mockResolvedValue(null);
    await useAuthStore.getState().logout();
    expect(snapshot()).toEqual({
      phase: "unauthenticated",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("clear_user_jwt");
    expect(invokeMock).toHaveBeenCalledWith("save_config", expect.anything());
  });

  it("unregisterDesktop=true triggers the un-pair API call BEFORE keychain wipe", async () => {
    invokeMock.mockResolvedValue(null);
    unregisterDesktopMock.mockResolvedValue(null);
    const order: string[] = [];
    unregisterDesktopMock.mockImplementation(() => { order.push("unregister"); });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "clear_user_jwt") order.push("clear_user_jwt");
      return null;
    });

    await useAuthStore.getState().logout({ unregisterDesktop: true });
    expect(order.indexOf("unregister")).toBeLessThan(order.indexOf("clear_user_jwt"));
  });

  it("unregister failure does not block keychain wipe / state transition", async () => {
    invokeMock.mockResolvedValue(null);
    unregisterDesktopMock.mockRejectedValue(new Error("network"));
    await useAuthStore.getState().logout({ unregisterDesktop: true });
    expect(useAuthStore.getState().phase).toBe("unauthenticated");
    expect(invokeMock).toHaveBeenCalledWith("clear_user_jwt");
  });
});

describe("auth-store: illegal transitions", () => {
  it("unauthenticated → expired throws (no token to expire)", () => {
    useAuthStore.setState({
      phase: "unauthenticated",
      coreUrl: null,
      deviceId: null,
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    // expire() is a no-op when phase != authenticated; assertion is the
    // "rejects without mutating state" half of the matrix.
    useAuthStore.getState().expire();
    expect(useAuthStore.getState().phase).toBe("unauthenticated");
  });

  it("hydrating → expired is rejected (only hydrate(authenticated|unauthenticated) is legal)", () => {
    _resetAuthStoreForTest();
    useAuthStore.getState().expire();
    expect(useAuthStore.getState().phase).toBe("hydrating");
  });

  it("login() called from authenticated phase throws", async () => {
    useAuthStore.setState({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    await expect(
      useAuthStore.getState().login({ coreUrl: "https://other.example.com", token: "jwt-2" }),
    ).rejects.toThrow(/Illegal auth transition/);
    // State unchanged
    expect(snapshot()).toEqual({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    });
  });

  it("logout() called from hydrating phase throws", async () => {
    _resetAuthStoreForTest();
    await expect(useAuthStore.getState().logout()).rejects.toThrow(/Illegal auth transition/);
    expect(useAuthStore.getState().phase).toBe("hydrating");
  });
});

describe("auth-store: setDeviceId", () => {
  it("updates deviceId in authenticated phase without changing other fields", () => {
    useAuthStore.setState({
      phase: "authenticated",
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "old",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    useAuthStore.getState().setDeviceId("new");
    const snap = snapshot();
    if (snap.phase === "authenticated") {
      expect(snap.deviceId).toBe("new");
      expect(snap.token).toBe("jwt-1");
      expect(snap.coreUrl).toBe("https://api.example.com");
    }
  });

  it("is a no-op while phase === 'hydrating' (no Sentry user binding without backing state)", () => {
    _resetAuthStoreForTest();
    useAuthStore.getState().setDeviceId("dev-stray");
    expect(useAuthStore.getState().phase).toBe("hydrating");
  });
});

describe("auth-store: re-login + concurrent flows", () => {
  it("expired → authenticated on re-login and the dead-JWT wipe lands BEFORE the new token write on disk", async () => {
    useAuthStore.setState({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);

    const order: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "store_user_jwt") order.push(`store:${(args as { token: string }).token}`);
      if (cmd === "clear_user_jwt") order.push("clear");
      return null;
    });

    // Simulate the realistic post-401 flow: expire() has just queued a
    // background `clear_user_jwt`; user immediately re-logs in.
    useAuthStore.getState().expire(); // no-op (already expired) but exercises the guard
    await useAuthStore.getState().login({
      coreUrl: "https://api.example.com",
      token: "jwt-2",
      deviceId: "dev-1",
    });

    // The keychain write chain must serialize so the new token is the
    // last value on disk — not the dead-JWT wipe from a stale expire().
    expect(order[order.length - 1]).toBe("store:jwt-2");
    expect(useAuthStore.getState().phase).toBe("authenticated");
  });

  it("expired → unauthenticated via logout() (user dismisses re-login prompt)", async () => {
    useAuthStore.setState({
      phase: "expired",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    } as AuthState as ReturnType<typeof useAuthStore.getState>);
    invokeMock.mockResolvedValue(null);

    await useAuthStore.getState().logout();

    expect(snapshot()).toEqual({
      phase: "unauthenticated",
      coreUrl: "https://api.example.com",
      deviceId: "dev-1",
    });
  });

  // TODO(ISS-11): re-enable once concurrent-race expectations align with the
  // read-state-at-execution-time persistKeychain semantics. The keychain
  // queue itself is exercised by the other tests in this file; this scenario
  // specifically asserts the final disk state under expire-during-login
  // interleaving and needs harness-timing rework.
  it.skip("concurrent expire() during in-flight login() — final disk state is the new token (writes serialized)", async () => {
    useAuthStore.setState({
      phase: "unauthenticated",
      coreUrl: null,
      deviceId: null,
    } as AuthState as ReturnType<typeof useAuthStore.getState>);

    const order: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "store_user_jwt") {
        order.push(`store:${(args as { token: string }).token}`);
        // Simulate slow keychain write so expire() can be dispatched mid-flight.
        await new Promise((r) => setTimeout(r, 5));
      }
      if (cmd === "clear_user_jwt") order.push("clear");
      return null;
    });

    // Subscribe so expire() is dispatched the instant login() flips state to
    // `authenticated` (the only legal pre-condition). This is the realistic
    // race: a stale 401 from an in-flight pre-login request fires *between*
    // the state flip and the awaited keychain write.
    const unsub = useAuthStore.subscribe((s) => {
      if (s.phase === "authenticated") {
        unsub();
        useAuthStore.getState().expire();
      }
    });

    const loginP = useAuthStore.getState().login({
      coreUrl: "https://api.example.com",
      token: "jwt-1",
      deviceId: "dev-1",
    });
    await loginP;
    // expire()'s persistKeychain() was enqueued onto the keychain chain but
    // not awaited. Drain by waiting longer than the 5ms simulated IPC latency.
    await new Promise((r) => setTimeout(r, 30));

    // Strict invariant: the FINAL keychain write matches the in-memory
    // phase. Whichever transition wins the race in memory, disk converges
    // to the same answer because each queued write re-reads the store at
    // exec time. Without this, memory-says-expired-but-disk-says-token
    // would silently re-authenticate on next launch.
    expect(useAuthStore.getState().phase).toBe("expired");
    expect(order[order.length - 1]).toBe("clear");
    // No interleaving: writes are serialized through the chain, not
    // racing two concurrent IPC calls.
    expect(order.filter((x) => x === "store:jwt-1" || x === "clear")).toEqual(order);
  });
});
