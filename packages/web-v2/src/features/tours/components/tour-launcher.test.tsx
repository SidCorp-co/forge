// A `?tour=` link opens its tour on the page it names: the popover walks the steps whose anchors are
// drawn, a missing anchor is skipped and recorded, and how the person left it is stored per revision.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { TourLauncher } from "./tour-launcher";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => "/projects/forge/releases/0.4.0-dev.87",
}));

function Page({ risk = true }: { risk?: boolean }) {
  return (
    <main>
      <section data-tour="rel-changes">What changes</section>
      {risk && <ul data-tour="rel-risk">Risks</ul>}
      <div data-tour="rel-design">Design</div>
      <TourLauncher />
    </main>
  );
}

let calls: Call[];
const original = Element.prototype.getClientRects;

beforeEach(() => {
  replace.mockClear();
  // jsdom lays nothing out, so every element reads as undrawn; a drawn anchor has one box
  Element.prototype.getClientRects = function (this: Element) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  window.history.replaceState(null, "", "/projects/forge/releases/0.4.0-dev.87?tab=overview&tour=release-what-changes");
  calls = fakeCore((call) => {
    if (call.path === "/me/product-state") return { body: { items: [] } };
    if (call.path.startsWith("/me/whats-new")) return { status: 503, body: { code: "WHATS_NEW_PLATFORM_UNSET" } };
    if (call.method === "POST" && call.path === "/me/tour-events") return { status: 201, body: { act: "recorded", id: "e" } };
    if (call.method === "PUT" && call.path.startsWith("/me/product-state/tour:")) return { body: { key: "tour:release-what-changes", value: call.body, updatedAt: "" } };
    return undefined;
  });
});

afterEach(() => {
  Element.prototype.getClientRects = original;
  document.querySelector(".driver-popover")?.remove();
});

function press(selector: string) {
  const button = document.querySelector(selector);
  if (!button) throw new Error(`no ${selector} on the page`);
  fireEvent.click(button);
}

const events = () => calls.filter((c) => c.path === "/me/tour-events").map((c) => c.body as { kind: string; step?: number });

describe("a ?tour= deep link", () => {
  it("opens the tour on its page, takes the parameter off the address, and stores it completed at its revision", async () => {
    renderWithQuery(<Page />);
    expect(await screen.findByText("What this release changes")).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/projects/forge/releases/0.4.0-dev.87?tab=overview", { scroll: false });
    press(".driver-popover-next-btn");
    await screen.findByText("Changes to watch");
    press(".driver-popover-next-btn");
    await screen.findByText("Design ships nothing");
    press(".driver-popover-next-btn");
    await waitFor(() => expect(events().map((e) => e.kind)).toEqual(["started", "completed"]));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/me/product-state/tour:release-what-changes");
    expect(put?.body).toMatchObject({ value: { revision: 1, outcome: "completed" } });
  });

  it("skips a step whose anchor is missing, records it, and stores a dismissal at the step it was closed on", async () => {
    renderWithQuery(<Page risk={false} />);
    expect(await screen.findByText("What this release changes")).toBeInTheDocument();
    press(".driver-popover-next-btn");
    expect(await screen.findByText("Design ships nothing")).toBeInTheDocument();
    expect(screen.queryByText("Changes to watch")).toBeNull();
    press(".driver-popover-close-btn");
    await waitFor(() =>
      expect(events()).toEqual([
        { tourId: "release-what-changes", revision: 1, kind: "step_skipped", step: 2 },
        { tourId: "release-what-changes", revision: 1, kind: "started" },
        { tourId: "release-what-changes", revision: 1, kind: "dismissed", step: 3 },
      ]),
    );
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ value: { revision: 1, outcome: "dismissed", step: 3 } });
  });
});
