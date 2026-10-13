// The contract page reads as the contract's state (REQ-43): each fact is said once (BC-5), and the
// agent text behind it — change paths, change kinds and levels, the code module — is drawn only in
// the Developer view, `?view=developer` (BC-7). The page is the vi walking test's "Contract detail".

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { SCREENS } from "@/test/vi-chrome-contracts";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

const page = (search: string) => {
  window.history.replaceState(null, "", `/projects/hop/contracts/hop/orders${search}`);
  const s = SCREENS.find((x) => x.name === "Contract detail");
  if (!s) throw new Error("the contract fixture has no Contract detail screen");
  return render(<InterfaceLanguageScope language="en">{s.render()}</InterfaceLanguageScope>);
};

const railLabels = () => [...screen.getByTestId("contract-facts").querySelectorAll("[data-fact-label]")].map((el) => el.textContent?.trim());

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the contract page says each fact once (REQ-43 BC-5)", () => {
  it("leaves the header's state, the rail's provider and current version, and the tab's counts out of the overview", () => {
    page("");
    const overview = screen.getByTestId("view-overview");
    expect(overview.querySelector("[data-family='contractState']"), "the overview repeats the header's state badge").toBeNull();
    expect(within(overview).queryByText("Provider"), "the overview repeats the rail's provider").toBeNull();
    expect(within(overview).queryByText(/recorded$/), "the overview repeats the Versions tab's count").toBeNull();
    expect(within(overview).queryByText(/· current$/), "the timeline repeats the rail's current version").toBeNull();
    expect(overview.querySelectorAll("[data-testid='pcc-consumer']"), "the overview repeats the Adoption tab's consumer rows").toHaveLength(0);
    expect(within(overview).getByTestId("adoption-strip").textContent).toContain("1 of 2 on latest");
    expect(railLabels()).toContain("Version");
  });
});

describe("the contract page folds agent text behind the Developer view (REQ-43 BC-7)", () => {
  it("draws no change path, change kind or level, and no code module, in the person view", () => {
    page("?tab=versions");
    const versions = screen.getByTestId("view-versions");
    expect(versions.querySelector("code"), "a change's element path is drawn in the person view").toBeNull();
    expect(within(versions).queryByText("orders.total")).toBeNull();
    expect(railLabels()).not.toContain("Module");
    expect(screen.getByTestId("record-view-switch")).toBeTruthy();
  });

  it("names the version the wait is for, and not how core measured the change", () => {
    page("");
    const banner = screen.getByText(/approve or return/);
    expect(banner.textContent).toContain("approve or return 2.0.0");
    expect(banner.textContent, "the wait prints core's measure code").not.toMatch(/measured|breaking/);
  });

  it("draws the change paths, kinds and the code module in the Developer view", () => {
    page("?tab=versions&view=developer");
    const versions = screen.getByTestId("view-versions");
    expect(within(versions).getAllByText("orders.total").length).toBeGreaterThan(0);
    expect(railLabels()).toContain("Module");
  });
});
