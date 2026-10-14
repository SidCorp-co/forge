// @vitest-environment jsdom
//
// ISS-1292 — a client-side navigation to an unknown guide lands here, inside the docs' own chrome.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_PATH_HEADER } from "@/features/guides/requested-path";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ [GUIDE_PATH_HEADER]: "/guides/no-such-guide" }),
}));

const { default: GuideNotFound } = await import("./not-found");

describe("the not-found of an unknown guide", () => {
  it("names the guide asked for, inside the docs header, with the way on to the index", async () => {
    render(await GuideNotFound());

    expect(screen.getByRole("heading", { name: "Forge publishes no guide called “no-such-guide”" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("Forge documentation");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading"));
    expect(screen.getByRole("link", { name: "All three ways in" })).toHaveAttribute("href", "/guides");
  });
});
