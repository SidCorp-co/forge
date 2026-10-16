// The release page's Technical view says how its close is proved: on a storefront, by what the provider
// serves, never by a commit nothing records there; the overview leaves it to the Technical view.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReader } from "./release-reader";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const page = (check: "provider" | "deployment" | null, provider: string | null, view: "user" | "developer" = "developer") => {
  const base = releasePage();
  return releasePage({
    view,
    technical: view === "developer" ? TECHNICAL : null,
    header: { ...base.header, verified: { ...base.header.verified, check, provider } },
  });
};

describe("Verified by on a release", () => {
  it("names the storefront provider whose published state proves the release", () => {
    renderWithQuery(<ReleaseReader page={page("provider", "Autoflow")} slug="hop" authed />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("What Autoflow serves");
  });

  it("keeps a git project's deployment record as it was", () => {
    renderWithQuery(<ReleaseReader page={page("deployment", "Coolify")} slug="hop" authed />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("Production's deployment record");
  });

  it("says nothing where no way of proving it is known, and nothing of it on the overview", () => {
    const { unmount } = renderWithQuery(<ReleaseReader page={page(null, null)} slug="hop" authed />);
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
    unmount();
    renderWithQuery(<ReleaseReader page={page("provider", "Autoflow", "user")} slug="hop" authed />);
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
  });
});
