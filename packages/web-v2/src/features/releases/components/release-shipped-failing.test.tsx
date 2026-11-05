// A recorded landing that shipped failing criteria says so (REQ-45 BC-14): under Needs attention by
// count, to every reader, a shared link's included (ISS-1001: no issue key in what users read), and by
// name in the banner the Technical section carries: the issues closed because the work shipped, and
// these are the follow-up's evidence.

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { renderWithQuery } from "@/test/render";
import { ShippedFailingBanner } from "./release-bits";
import { ReleaseReport } from "./release-report";

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

  const failingItem = () => screen.queryAllByTestId("page-attention-item").find((i) => i.dataset.kind === "failing");

  it("says it shipped failing to a reader who is not signed in, with no issue key", () => {
    renderWithQuery(<ReleaseReport page={failing} />);
    expect(failingItem()?.textContent).toBe("1 criteria shipped failing");
    expect(screen.getByTestId("release-report").textContent).not.toContain("ISS-5");
  });

  it("says nothing of it where nothing it carried failed", () => {
    renderWithQuery(<ReleaseReport page={releasePage()} />);
    expect(failingItem()).toBeUndefined();
  });
});
