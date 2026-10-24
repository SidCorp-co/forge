// The requirement peek says what the requirement says and lists its criteria, so a reader judges it
// without the full page: the summary the Overview leads with, held to an excerpt, and each criterion's
// verdict, code and words, the first eight with how many more. A requirement with no words or no
// criteria yet shows no section for them, and the peek still carries one waiting-on and one count.

import type { BcVerdict } from "@forge/contracts/requirements";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { core, peek, secondProgress } from "@/test/requirement-progress";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const criterion = (n: number, verdict: BcVerdict = "not_judged") => ({ code: `BC-${n}`, body: `Criterion ${n} words`, verdict, issues: [], verdicts: [], counts: null, why: null, uncoveredReason: null });
const withCoverage = (coverage: ReturnType<typeof criterion>[]) => ({ ...reqDetail, standing: { ...reqDetail.standing, coverage } }) as RequirementDetail;
const withoutWords = {
  ...reqDetail,
  revisions: reqDetail.revisions.map((r) => ({ ...r, tldr: null, spec: { ...r.spec, goal: undefined } })),
} as RequirementDetail;

describe("the requirement peek", () => {
  it("says what the current revision says, in an excerpt, above the facts", () => {
    core();
    peek();
    const summary = screen.getByTestId("peek-summary");
    expect(within(summary).getByTestId("peek-excerpt")).toHaveTextContent("Tom tat 1");
    expect(summary.compareDocumentPosition(screen.getByTestId("requirement-facts")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists each criterion with its verdict, code and words", () => {
    core();
    peek();
    const rows = within(screen.getByTestId("peek-criteria")).getAllByTestId("criterion-row");
    expect(rows.map((r) => r.getAttribute("data-verdict"))).toEqual(reqDetail.standing.coverage.map((c) => c.verdict));
    expect(rows[0]).toHaveTextContent(/BC-1.*Tieu chi mot/);
    expect(within(rows[0]).getByTestId("verdict-dot")).toHaveAttribute("data-verdict", "passing");
    expect(screen.queryByTestId("peek-criteria-more")).toBeNull();
  });

  it("shows the first eight criteria and says how many more the full page holds", () => {
    core();
    peek(withCoverage(Array.from({ length: 11 }, (_, i) => criterion(i + 1))));
    expect(within(screen.getByTestId("peek-criteria")).getAllByTestId("criterion-row")).toHaveLength(8);
    expect(screen.getByTestId("peek-criteria-more")).toHaveTextContent(/^\+3 more$/);
  });

  it("leaves out the summary and the criteria where the requirement has neither yet", () => {
    core();
    peek({ ...withoutWords, standing: { ...withoutWords.standing, coverage: [] } });
    expect(screen.queryByTestId("peek-summary")).toBeNull();
    expect(screen.queryByTestId("peek-criteria-group")).toBeNull();
    expect(screen.getByTestId("requirement-facts")).toBeInTheDocument();
  });

  it("still says whom it waits on and how much is verified once, in the strip", () => {
    core();
    peek();
    expect(secondProgress(document.body, reqDetail.standing)).toBeNull();
  });
});
