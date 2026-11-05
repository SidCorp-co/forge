// The release page's Technical view says how its close is proved: on a storefront, by what the provider
// serves, never by a commit nothing records there; the report users read leaves it to the Technical section (ISS-1001).

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ReleaseReport } from "./release-report";
import { Technical } from "./release-technical";

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
    renderWithQuery(<Technical page={page("provider", "Autoflow")} slug="hop" />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("What Autoflow serves");
  });

  it("keeps a git project's deployment record as it was", () => {
    renderWithQuery(<Technical page={page("deployment", "Coolify")} slug="hop" />);
    expect(screen.getByTestId("release-verified-by").textContent).toContain("Production's deployment record");
  });

  it("says nothing where no way of proving it is known, and nothing of it on the overview", () => {
    const { unmount } = renderWithQuery(<Technical page={page(null, null)} slug="hop" />);
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
    unmount();
    renderWithQuery(<ReleaseReport page={page("provider", "Autoflow", "user")} />);
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
  });
});
