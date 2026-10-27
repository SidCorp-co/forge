// A recorded landing that shipped failing criteria says so loud above the release page, naming each
// (REQ-45 BC-14): the issues closed because the work shipped, and these are the follow-up's evidence.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ShippedFailingBanner } from "./release-bits";
import { ReleaseReader } from "./release-reader";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

describe("a release that shipped failing criteria", () => {
  it("says how many failed and names each, by issue", () => {
    renderWithQuery(
      <ShippedFailingBanner
        r={{
          shippedFailing: {
            count: 3,
            sentence: "Shipped with 3 failing criteria: ISS-5 c2, ISS-7 c1-2",
            criteria: [
              { issueId: "a", issueKey: "ISS-5", criterion: 2 },
              { issueId: "b", issueKey: "ISS-7", criterion: 1 },
              { issueId: "b", issueKey: "ISS-7", criterion: 2 },
            ],
          },
        }}
      />,
    );
    const banner = screen.getByTestId("release-shipped-failing");
    expect(banner.textContent).toContain("Shipped with 3 failing criteria");
    expect(banner.textContent).toContain("ISS-5 c2; ISS-7 c1, c2");
  });

  it("says nothing where nothing it carried failed", () => {
    renderWithQuery(<ShippedFailingBanner r={{ shippedFailing: null }} />);
    expect(screen.queryByTestId("release-shipped-failing")).toBeNull();
  });
});

describe("a release that shipped failing criteria, read from a shared link (REQ-45 BC-14)", () => {
  const failing = releasePage({
    header: {
      ...releasePage().header,
      shippedFailing: {
        count: 1,
        sentence: "Shipped with 1 failing criterion: ISS-5 c2",
        criteria: [{ issueId: "i5", issueKey: "ISS-5", criterion: 2 }],
      },
    },
  });

  it("says it shipped failing, naming the criterion, to a reader who is not signed in", () => {
    renderWithQuery(<ReleaseReader page={failing} authed={false} />);
    const banner = screen.getByTestId("release-shipped-failing");
    expect(banner.textContent).toContain("Shipped with 1 failing criteria");
    expect(banner.textContent).toContain("ISS-5 c2");
  });

  it("draws no banner where nothing it carried failed", () => {
    renderWithQuery(<ReleaseReader page={releasePage()} authed={false} />);
    expect(screen.queryByTestId("release-shipped-failing")).toBeNull();
  });
});
