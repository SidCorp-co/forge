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

/** Minimal Web Audio fake: records how many oscillators were `start()`ed and
 *  lets a test flip the context from `suspended` → `running` via resume(). */
function makeAudioContextCtor(initialState: "running" | "suspended") {
  const starts: number[] = [];
  let resolveResume: (() => void) | null = null;
  const ctor = function (this: Record<string, unknown>) {
    let state = initialState;
    this.currentTime = 0;
    Object.defineProperty(this, "state", { get: () => state });
    this.destination = {};
    this.resume = () =>
      new Promise<void>((resolve) => {
        resolveResume = () => {
          state = "running";
          resolve();
        };
      });
    this.createGain = () => ({
      connect: () => {},
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
    });
    this.createOscillator = () => ({
      type: "",
      frequency: { setValueAtTime: () => {} },
      connect: () => {},
      start: (t: number) => starts.push(t),
      stop: () => {},
    });
  } as unknown as typeof AudioContext;
  return { ctor, starts, flushResume: () => resolveResume?.() };
}

/** Fresh import of the module so its singleton AudioContext + gesture-primer
 *  guard don't leak between tests. */
async function freshSound() {
  vi.resetModules();
  return import("./sound");
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

  it("plays immediately on a RUNNING context when opted in", async () => {
    const { ctor, starts } = makeAudioContextCtor("running");
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: ctor,
    };
    const sound = await freshSound();
    sound.setEnabled(true);
    sound.playNotificationSound();
    expect(starts).toHaveLength(1); // chime scheduled synchronously
  });

  it("resumes a SUSPENDED context and schedules the chime only AFTER resume resolves", async () => {
    const { ctor, starts, flushResume } = makeAudioContextCtor("suspended");
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: ctor,
    };
    const sound = await freshSound();
    sound.setEnabled(true);
    sound.playNotificationSound();
    expect(starts).toHaveLength(0); // nothing scheduled against the frozen clock
    flushResume();
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toHaveLength(1); // chime emitted once the context is running
  });
});

describe("playPreviewCue", () => {
  it("plays even when NOT opted in (immediate enable confirmation)", async () => {
    const { ctor, starts } = makeAudioContextCtor("running");
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: ctor,
    };
    const sound = await freshSound();
    // enabled flag deliberately left OFF — preview ignores the persisted gate
    sound.playPreviewCue();
    expect(starts).toHaveLength(1);
  });

  it("never throws when window is absent", async () => {
    const sound = await freshSound();
    expect(() => sound.playPreviewCue()).not.toThrow();
  });
});

describe("installGesturePrimer", () => {
  it("resumes the context on a gesture when enabled, and is idempotent", async () => {
    const { ctor } = makeAudioContextCtor("suspended");
    const handlers: Record<string, Array<() => void>> = {};
    const addEventListener = vi.fn((type: string, fn: () => void) => {
      (handlers[type] ??= []).push(fn);
    });
    (globalThis as { window?: unknown }).window = {
      localStorage: makeLocalStorage(),
      AudioContext: ctor,
      addEventListener,
    };
    const sound = await freshSound();
    sound.setEnabled(true);
    sound.installGesturePrimer();
    sound.installGesturePrimer(); // second call must not re-register
    expect(addEventListener).toHaveBeenCalledTimes(2); // pointerdown + keydown, once
    // Firing a gesture resumes the context (no throw, exercises the enabled path)
    expect(() => handlers.pointerdown?.[0]?.()).not.toThrow();
  });

  it("never throws when window is absent", async () => {
    const sound = await freshSound();
    expect(() => sound.installGesturePrimer()).not.toThrow();
  });
});
