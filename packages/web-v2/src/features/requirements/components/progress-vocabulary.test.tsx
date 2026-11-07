// JU-2: hop REQ-19 read "Issues done 0/6" on the requirements list and "5/6 landed" on Releases, and
// both said "xong" in Vietnamese. Core's one progress — shipped, landed awaiting release, to do — is
// printed through one function (`IssueProgressText`, the status report's), and the Vietnamese words
// for landed and shipped differ. Releases no longer repeats it (ISS-1001).

import type { RequirementForecasts, ScopeForecast } from "@forge/contracts/forecast";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueProgressText } from "@/features/forecast";
import { PRODUCT_STRINGS as product } from "@/lib/i18n/product-copy";
import { REQ_PROJECT, reqQueries, Seeded } from "@/test/vi-chrome-requirements";
import { RequirementsScreen } from "./requirements-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

const stamp = { label: "forecast" as const, asOf: "2026-10-07T12:00:00Z" };
const REQ_19: ScopeForecast = {
  ...stamp,
  scope: "requirement", anchor: { at: "2026-10-07T00:00:00.000Z", event: { key: "forecast.event.none" } }, moved: null,
  key: "REQ-1",
  title: "Muc",
  progress: { total: 6, shipped: 0, awaitingRelease: 5, toDo: 1 },
  forecast: null,
  next: null,
  delivery: null,
};
const forecasts: RequirementForecasts = { ...stamp, projectId: REQ_PROJECT, requirements: [REQ_19] };

function listText(): string {
  const { container, unmount } = render(
    <Seeded data={[...reqQueries(), [["issues", "standing", "forecast", "requirements", REQ_PROJECT], forecasts]]}>
      <RequirementsScreen projectId={REQ_PROJECT} slug="hop" />
    </Seeded>,
  );
  const text = container.textContent ?? "";
  unmount();
  return text;
}

function progressOf(): string {
  const { unmount } = render(<IssueProgressText progress={REQ_19.progress} />);
  const text = screen.getByTestId("issue-progress").textContent ?? "";
  unmount();
  return text;
}

describe("one progress, printed by one function", () => {
  it("prints REQ-19 progress, and the requirements list prints none", () => {
    expect(progressOf()).toBe("0 shipped · 5 landed, awaiting release · 1 to do");
    // the list is one line per requirement now (REQ-29 BC-4) and prints no issue progress
    expect(listText()).not.toContain("awaiting release");
  });
});

describe("the progress words", () => {
  const en = product.en;

  it("keeps no count that called closed issues done", () => {
    for (const k of ["requirements.row.issuesDone", "requirements.facts.doneOf", "releases.landedOf", "fc.scopeHead", "standing.act.done"]) {
      expect(en[k]).toBeUndefined();
    }
  });
});
