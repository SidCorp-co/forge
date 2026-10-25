// ISS-683 (REQ-74 BC-2): a builder's own pass recorded before the cutover still counts, so it is
// listed as proven; the Technical view marks that row "Builder", so a reader can see whose pass it is.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { releasePage } from "@/test/release-page";
import { ChangeDetail, checksByIssue } from "./release-row-detail";

function drawn(countedUnderCutover: boolean) {
  const base = releasePage({ view: "developer" });
  const [req] = base.requirements;
  if (!req) throw new Error("no requirement in the fixture");
  const page = {
    ...base,
    requirements: [{ ...req, proven: req.proven.map((p) => (p.n === 2 ? { ...p, countedUnderCutover } : p)) }],
  };
  const [change] = page.improvements;
  if (!change) throw new Error("no change in the fixture");
  renderWithQuery(<ChangeDetail page={page} change={change} checks={checksByIssue(page).get("ISS-1")} reach={{ authed: true }} />);
  return screen.getByTestId("page-row-detail");
}

describe("a builder's pass counted under the cutover on the release page", () => {
  it("marks that proven row Builder, and only that one", () => {
    const rows = [...drawn(true).querySelectorAll("li")];
    const marked = rows.filter((li) => within(li).queryByTestId("proof-builder-mark"));
    expect(marked.map((li) => li.textContent)).toEqual(["✓#2The page names who approved it.Builder"]);
    expect(within(marked[0] as HTMLElement).getByTestId("proof-builder-mark")).toHaveAttribute("title", "Passed by the run that built it, before independent judging began");
  });

  it("marks no row where no proven row is a builder's pass", () => {
    expect(within(drawn(false)).queryByTestId("proof-builder-mark")).toBeNull();
  });
});

