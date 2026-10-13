// REQ-34 BC-17 (ISS-456): a revision's reason is asked, never required, so a revision may hold none
// until its author answers. The open revision then shows its change summary and no "Why:" line of
// an empty reason; a revision with a reason still says why.

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { core, page } from "@/test/requirement-progress";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const withReason = (reason: string | null): RequirementDetail => ({
  ...reqDetail,
  revisions: reqDetail.revisions.map((r) => (r.state === "proposed" ? { ...r, reason } : r)),
});

describe("the open revision's reason", () => {
  it("shows its change summary and no why line while its reason is not given yet", () => {
    core();
    page("revisions", withReason(null));
    const open = screen.getByTestId("open-revision");
    expect(open).toHaveTextContent("Thay doi 2");
    expect(within(open).queryByText(/^Why:/)).toBeNull();
    expect(open.textContent).not.toMatch(/Why:\s*$/m);
  });

  it("says why once a reason is given", () => {
    core();
    page("revisions", withReason("Ly do moi"));
    expect(within(screen.getByTestId("open-revision")).getByText("Why: Ly do moi")).toBeInTheDocument();
  });
});
