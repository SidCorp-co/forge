import { afterEach, describe, expect, it, vi } from "vitest";
import { isEnabled, isSupported, playNotificationSound, primeAudio, setEnabled } from "./sound";

// The vitest env is `node`, so there is no DOM. Each test installs the exact
// globals (window / localStorage / AudioContext) it needs and tears them down
// after, since sound.ts reads `typeof window` lazily at call time.

const OPT_IN_KEY = "forge:notify-sound";

function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

afterEach(() => {
  // biome-ignore lint/performance/noDelete: test global teardown
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("opt-in flag (forge:notify-sound)", () => {
  it("round-trips isEnabled / setEnabled through localStorage", () => {
    (globalThis as { window?: unknown }).window = { localStorage: makeLocalStorage() };
    expect(isEnabled()).toBe(false); // default OFF
    setEnabled(true);
    expect((globalThis as { window: { localStorage: Storage } }).window.localStorage.getItem(OPT_IN_KEY)).toBe("1");
    expect(isEnabled()).toBe(true);
    setEnabled(false);
    expect(isEnabled()).toBe(false);
  });

  it("reports disabled and never throws when window is absent (SSR)", () => {
    expect(isEnabled()).toBe(false);
    expect(() => setEnabled(true)).not.toThrow();
  });
});

describe("isSupported", () => {
  it("is false when window is absent", () => {
    expect(isSupported()).toBe(false);
  });

  it("is false when no AudioContext constructor exists", () => {
    (globalThis as { window?: unknown }).window = { localStorage: makeLocalStorage() };
    expect(isSupported()).toBe(false);
  });

  it("is true when AudioContext is present", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: function () {} as unknown,
    };
    expect(isSupported()).toBe(true);
  });
});

describe("playNotificationSound", () => {
  it("is a no-op (never constructs audio) when not opted in", () => {
    const ctor = vi.fn();
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: ctor as unknown,
    };
    // enabled flag not set → default OFF
    expect(() => playNotificationSound()).not.toThrow();
    expect(ctor).not.toHaveBeenCalled();
  });

  it("never throws when AudioContext is missing even if opted in", () => {
    const ls = makeLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: ls };
    setEnabled(true);
    expect(() => playNotificationSound()).not.toThrow();
  });

  it("never throws when window is absent", () => {
    expect(() => playNotificationSound()).not.toThrow();
    expect(() => primeAudio()).not.toThrow();
  });
});
