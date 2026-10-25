// forge-core-eb's ruling of 2026-10-14: the Criteria tab drew a short with the same green ✓ as a
// pass, so a criterion met short of its wording (never proven) read as passed at a glance. A short's
// mark is the ✓ drawn hollow in the warn tone, with its word in the row from md up; pass, fail, skipped
// and not-judged keep the marks they had.

import { screen } from "@testing-library/react";
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
  renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "in_progress" } as IssueDetail} projectId="p1" checklist={[]} canWrite={false} requirementKey={null} />);
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
    renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "in_progress" } as IssueDetail} projectId="p1" checklist={[]} canWrite={false} requirementKey={null} />);
    const word = await screen.findByTestId("criterion-1-builder");
    expect(word).toHaveTextContent(/^Builder$/);
    expect(word).toHaveAttribute("title", "Passed by the run that built it, before independent judging began");
    expect(screen.queryByTestId("criterion-2-builder")).toBeNull();
  });
});

describe("a pass no release counts on the Criteria tab", () => {
  const why = "recorded before the reopen on 2026-10-23 07:13 UTC; judge it again";
  it("marks the row Not counted, saying why, where the reopen voided its pass, and leaves a counted pass unmarked", async () => {
    fakeCore((c) =>
      c.path === "/issues/i1/criteria"
        ? {
            body: {
              criteria: [
                { ...criterion(1, judged("pass")), counts: { counted: false, why } },
                { ...criterion(2, judged("pass")), counts: { counted: true, why: null } },
              ],
            },
          }
        : undefined,
    );
    renderWithQuery(<IssueCriteria issue={{ id: "i1", projectId: "p1", status: "awaiting_release" } as IssueDetail} projectId="p1" checklist={[]} canWrite={false} requirementKey={null} />);
    const word = await screen.findByTestId("criterion-1-not-counted");
    expect(word).toHaveTextContent(/^Not counted$/);
    expect(word).toHaveAttribute("title", why);
    expect(screen.queryByTestId("criterion-2-not-counted")).toBeNull();
  });
});
