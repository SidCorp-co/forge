import { describe, it, expect, vi, beforeEach } from "vitest";
import { hydrateLocalConfig, type HydrateLocalConfigDeps } from "@/hooks/use-local-config";
import { useAppStore } from "@/stores/app-store";
import type { AppConfig } from "@/lib/types";

// ISS-15 / v0.1.27 deferred test. The protected lines are
// `packages/dev/src/hooks/use-local-config.ts` — the inline:
//
//     deps.configureApi(cfg.coreUrl, cfg.authToken);
//     deps.setConfig(cfg);
//
// must run in that order. Sentry surfaced a regression in v0.1.25 where
// flipping these lines published authToken into the store before the api
// client knew its baseUrl, which triggered a 401-driven logout-on-reload.
// Two angles cover the invariant: (a) Vitest's invocationCallOrder pins the
// raw call sequence, and (b) a real `useAppStore` subscription confirms that
// no observer ever sees authToken non-empty without configureApi already
// having fired at least once.

function emptyConfig(): AppConfig {
  return {
    coreUrl: "",
    authToken: "",
    projects: {},
    deviceId: "",
  } as AppConfig;
}

function makeDiskConfig(): AppConfig {
  return {
    coreUrl: "https://api.example.com",
    authToken: "",
    projects: {},
    deviceId: "device-1",
  } as AppConfig;
}

function makeDeps(overrides: Partial<HydrateLocalConfigDeps> = {}): HydrateLocalConfigDeps {
  const invokeFn = vi.fn(async (cmd: string) => {
    if (cmd === "get_config") return makeDiskConfig();
    if (cmd === "load_user_jwt") return "jwt-abc";
    return null;
  });
  const SentryStub = {
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setUser: vi.fn(),
  };
  return {
    invoke: invokeFn as unknown as HydrateLocalConfigDeps["invoke"],
    configureApi: vi.fn(),
    resolveApiBase: vi.fn().mockResolvedValue(null),
    setConfig: useAppStore.getState().setConfig,
    setConfigReady: useAppStore.getState().setConfigReady,
    Sentry: SentryStub as unknown as HydrateLocalConfigDeps["Sentry"],
    ...overrides,
  };
}

describe("hydrateLocalConfig: configureApi-before-setConfig invariant", () => {
  beforeEach(() => {
    useAppStore.setState({ config: emptyConfig(), configReady: false });
  });

  it("calls configureApi before setConfig (invocationCallOrder)", async () => {
    const configureApi = vi.fn();
    const setConfig = vi.fn();
    const deps = makeDeps({ configureApi, setConfig });

    await hydrateLocalConfig(deps);

    expect(configureApi).toHaveBeenCalled();
    expect(setConfig).toHaveBeenCalled();
    const firstConfigureApiOrder = configureApi.mock.invocationCallOrder[0]!;
    const firstSetConfigOrder = setConfig.mock.invocationCallOrder[0]!;
    expect(firstConfigureApiOrder).toBeLessThan(firstSetConfigOrder);
    expect(configureApi).toHaveBeenCalledWith("https://api.example.com", "jwt-abc");
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ coreUrl: "https://api.example.com", authToken: "jwt-abc" }),
    );
  });

  it("no store subscriber sees authToken non-empty before configureApi has fired", async () => {
    const configureApi = vi.fn();
    const observations: Array<{ authTokenSeen: boolean; configureApiCalls: number }> = [];
    const unsub = useAppStore.subscribe((state) => {
      observations.push({
        authTokenSeen: !!state.config.authToken,
        configureApiCalls: configureApi.mock.calls.length,
      });
    });

    const deps = makeDeps({ configureApi });
    await hydrateLocalConfig(deps);
    unsub();

    const tokenSnapshots = observations.filter((o) => o.authTokenSeen);
    expect(tokenSnapshots.length).toBeGreaterThan(0);
    for (const snap of tokenSnapshots) {
      expect(snap.configureApiCalls).toBeGreaterThanOrEqual(1);
    }
    expect(useAppStore.getState().configReady).toBe(true);
  });

  it("self-heals coreUrl when resolveApiBase returns a different origin", async () => {
    const configureApi = vi.fn();
    const setConfig = vi.fn();
    const deps = makeDeps({
      configureApi,
      setConfig,
      resolveApiBase: vi.fn().mockResolvedValue("https://api-resolved.example.com"),
    });

    await hydrateLocalConfig(deps);

    // Order across BOTH the initial configure and the heal-time configure
    // must still precede each setConfig call — pin via invocationCallOrder.
    expect(configureApi).toHaveBeenCalledTimes(2);
    expect(setConfig).toHaveBeenCalledTimes(2);
    expect(configureApi.mock.invocationCallOrder[0]!).toBeLessThan(
      setConfig.mock.invocationCallOrder[0]!,
    );
    expect(configureApi.mock.invocationCallOrder[1]!).toBeLessThan(
      setConfig.mock.invocationCallOrder[1]!,
    );
    expect(configureApi).toHaveBeenLastCalledWith(
      "https://api-resolved.example.com",
      "jwt-abc",
    );
  });
});
