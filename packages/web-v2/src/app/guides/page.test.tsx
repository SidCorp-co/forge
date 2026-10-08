// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

const fetchGuideCorpus = vi.fn(async () => {
  throw new Error("core is down");
});
const fetchGuideScope = vi.fn(async () => {
  throw new Error("core is down");
});
vi.mock("@/features/guides/api", () => ({ fetchGuideCorpus, fetchGuideScope }));

const { default: GuidesPage } = await import("./page");

async function open(params: Record<string, string>) {
  render(await GuidesPage({ searchParams: Promise.resolve(params) }));
}

describe("/guides refusing an address", () => {
  it.each([
    [{ for: "users" }, "The documentation has no door called “users”"],
    [{ path: "no-such-page" }, "Forge publishes no page called “no-such-page”"],
    [{ path: "getting-started", for: "user" }, "An address names a page or a door, not both"],
  ])("renders the refusal for %o without asking core", async (params, heading) => {
    fetchGuideCorpus.mockClear();
    await open(params);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(fetchGuideCorpus).not.toHaveBeenCalled();
  });

  it("still asks core, and fails loudly, for an address naming a real door", async () => {
    await expect(GuidesPage({ searchParams: Promise.resolve({ for: "user" }) })).rejects.toThrow("core is down");
  });
});
