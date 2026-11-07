// forge-core-eb's ruling of 2026-10-14: the Criteria tab drew a short with the same green ✓ as a
// pass, so a criterion met short of its wording (never proven) read as passed at a glance. A short's
// mark is the ✓ drawn hollow in the warn tone, with its word in the row from md up; pass, fail, skipped
// and not-judged keep the marks they had.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueDetail } from "../types";
import { IssueCriteria } from "./issue-criteria";

const AT = "2026-10-14T09:12:00.000Z";
const judged = (verdict: "pass" | "short" | "fail" | "skipped") => ({
  verdict,
  reason: "judged",
  identityKind: "commit",
  commitSha: "8e0e7dae6".padEnd(40, "0"),
  authorAgency: "agent",
  createdAt: AT,
});
const criterion = (n: number, latest: ReturnType<typeof judged> | null) => ({
  id: `k${n}`,
  n,
  statement: `Criterion ${n} holds`,
  position: n - 1,
  requirementCriterionId: null,
  latest,
});

async function drawn() {
  fakeCore((c) =>
    c.path === "/issues/i1/criteria"
      ? { body: { criteria: [criterion(1, judged("pass")), criterion(2, judged("short")), criterion(3, judged("fail")), criterion(4, judged("skipped")), criterion(5, null)] } }
      : undefined,
  );
  renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "in_progress" } as IssueDetail} checklist={[]} canWrite={false} />);
  await screen.findByTestId("criterion-2-verdict");
  return (n: number) => ({ mark: screen.getByTestId(`criterion-${n}-verdict`), word: screen.queryByTestId(`criterion-${n}-word`) });
}

const RULE = "a short is never drawn as a pass: its ✓ is hollow, in the warn tone, with its word from md up";

describe("a short's mark on the Criteria tab", () => {
  it("draws a short as the hollow warn ✓, its word Short shown in the row from md up", async () => {
    const short = (await drawn())(2);
    expect(short.mark.querySelector("svg[data-mark=hollow]"), RULE).not.toBeNull();
    expect(short.mark.textContent, RULE).not.toContain("✓");
    expect(short.mark.className, RULE).toMatch(/\btext-warn-11\b/);
    expect(short.mark.className, RULE).not.toMatch(/\btext-ok-11\b/);
    expect(short.mark).toHaveAccessibleName("Short");
    expect(short.word, RULE).not.toBeNull();
    expect(short.word).toHaveTextContent(/^Short$/);
    expect(short.word?.className, "the word is hidden on a phone and shown from md up").toMatch(/(^|\s)hidden(\s|$).*\bmd:inline\b/);
    expect(short.word?.className, RULE).toMatch(/\btext-warn-11\b/);
    // the mark carries the name; the word beside it is not read a second time
    expect(short.word).toHaveAttribute("aria-hidden", "true");
  });

  it("draws a pass as the solid green ✓ with no word, and fail, skipped and not-judged as before", async () => {
    const at = await drawn();
    const pass = at(1);
    expect(pass.mark.querySelector("svg[data-mark=hollow]"), "a pass is never hollow").toBeNull();
    expect(pass.mark).toHaveTextContent(/^✓$/);
    expect(pass.mark.className).toMatch(/\btext-ok-11\b/);
    expect(pass.mark).toHaveAccessibleName("Pass");
    expect(pass.word, "a pass carries no word").toBeNull();
    const rest = [3, 4, 5].map((n) => ({ text: at(n).mark.textContent, name: at(n).mark.getAttribute("aria-label"), tone: /text-(danger|subtle)/.exec(at(n).mark.className)?.[0], word: at(n).word }));
    expect(rest).toEqual([
      { text: "✕", name: "Fail", tone: "text-danger", word: null },
      { text: "↷", name: "Skipped", tone: "text-subtle", word: null },
      { text: "–", name: "Not judged", tone: "text-subtle", word: null },
    ]);
  });
});

describe("a builder's pass counted under the cutover on the Criteria tab (ISS-683)", () => {
  it("marks the row Builder where its latest verdict counts only under the cutover, and no other row", async () => {
    fakeCore((c) =>
      c.path === "/issues/i1/criteria"
        ? { body: { criteria: [criterion(1, { ...judged("pass"), countedUnderCutover: true } as ReturnType<typeof judged>), criterion(2, judged("pass"))] } }
        : undefined,
    );
    renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "in_progress" } as IssueDetail} checklist={[]} canWrite={false} />);
    const word = await screen.findByTestId("criterion-1-builder");
    expect(word).toHaveTextContent(/^Builder$/);
    expect(word).toHaveAttribute("title", "Passed by the run that built it, before independent judging began");
    expect(screen.queryByTestId("criterion-2-builder")).toBeNull();
  });
});

// Judge K91 at dev.318 (ISS-683 c1): core answered a builder's pass after the cutover as a plain pass
// with nothing saying it never counts, and the tab drew it ✓ under Met, like a judge's.
describe("a builder's pass that never counts on the Criteria tab (ISS-683, K91)", () => {
  const notCounted = { code: "VERDICT_BY_BUILDER", detail: "recorded by the run that built this issue, so it is kept as that run's evidence and never counts" };
  const RULE = "a pass only its builder recorded is not met: Met counts only passes that count";

  async function drawnWithBuilder() {
    fakeCore((c) =>
      c.path === "/issues/i1/criteria"
        ? {
            body: {
              criteria: [
                criterion(1, { ...judged("pass"), notCounted } as ReturnType<typeof judged>),
                criterion(2, { ...judged("pass"), notCounted: null } as ReturnType<typeof judged>),
                criterion(3, { ...judged("short"), notCounted } as ReturnType<typeof judged>),
              ],
            },
          }
        : undefined,
    );
    renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "in_progress" } as IssueDetail} checklist={[]} canWrite={false} />);
    await screen.findByTestId("criterion-1-verdict");
  }

  it("draws the builder's pass and short as not met, each marked with its reason on hover, and the judge's pass as met", async () => {
    await drawnWithBuilder();
    for (const n of [1, 3]) {
      const mark = screen.getByTestId(`criterion-${n}-verdict`);
      expect(mark.textContent, RULE).toBe("–");
      expect(mark).toHaveAccessibleName("Not judged");
      const word = screen.getByTestId(`criterion-${n}-builder-only`);
      expect(word).toHaveTextContent(/^Builder's pass$/);
      expect(word).toHaveAttribute("title", "Only its builder passed it; another run must judge it");
    }
    expect(screen.getByTestId("criterion-2-verdict")).toHaveTextContent(/^✓$/);
    expect(screen.queryByTestId("criterion-2-builder-only")).toBeNull();
    expect(screen.queryByTestId("criterion-1-builder"), "never also the cutover's Builder mark").toBeNull();
  });

  it("counts Met over the passes that count only", async () => {
    await drawnWithBuilder();
    expect(screen.getByRole("button", { name: "Met 1" }), RULE).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not judged 2" })).toBeInTheDocument();
  });

  it("says on the open row that the verdict does not count", async () => {
    await drawnWithBuilder();
    fireEvent.click(screen.getAllByTestId("criterion-row")[0]?.querySelector("button") as HTMLElement);
    expect(await screen.findByTestId("criterion-full")).toHaveTextContent("Builder's own pass, not counted");
  });
});
