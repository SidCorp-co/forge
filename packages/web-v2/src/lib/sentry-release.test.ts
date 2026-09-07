import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
vi.mock("@sentry/react", () => ({ init }));

// cm:why the browser bundle's release cannot be walked from a test: the value is inlined by Next at build time and the event is raised in a browser against a real DSN, so what a unit holds is the pair that must never regress.
const initWith = async (commit: string | undefined): Promise<Record<string, unknown>> => {
  if (commit === undefined) delete process.env.NEXT_PUBLIC_SOURCE_COMMIT;
  else process.env.NEXT_PUBLIC_SOURCE_COMMIT = commit;
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://examplePublicKey@o0.ingest.example.com/0";
  init.mockClear();
  vi.resetModules();
  const { initSentry } = await import("./sentry");
  expect(initSentry()).toBe(true);
  return init.mock.calls[0]?.[0] as Record<string, unknown>;
};

describe("web-v2 Sentry release", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SOURCE_COMMIT;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  it("is the commit the bundle was built from", async () => {
    const opts = await initWith("3dee4d1f24ed2733f22065ab3f7caf921585a904");
    expect(opts.release).toBe("3dee4d1f24ed2733f22065ab3f7caf921585a904");
  });

  it("attaches no release when the build was not told its commit", async () => {
    const opts = await initWith(undefined);
    expect(opts.release).toBeUndefined();
  });

  it("reports a value that is not a commit hash as missing rather than serving it", async () => {
    const opts = await initWith("HEAD");
    expect(opts.release).toBeUndefined();
  });

  it("never attaches at all without a DSN", async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    init.mockClear();
    vi.resetModules();
    const { initSentry } = await import("./sentry");
    expect(initSentry()).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });
});
