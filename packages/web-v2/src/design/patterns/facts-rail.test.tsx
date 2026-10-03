// @vitest-environment jsdom
//
// The facts rail: a group heads with its label-first counter; a coverage bar names only the
// segments present, and draws nothing over an empty whole.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoverageBar, Fact, FactsGroup, FactsRail } from "./facts-rail";

expect.extend(matchers);
afterEach(cleanup);

describe("FactsRail", () => {
  it("heads a group with its counter and lists label/value rows", () => {
    render(
      <FactsRail>
        <FactsGroup title="Criteria" count="Passing 2 of 4">
          <Fact label="Owner">Bao</Fact>
        </FactsGroup>
      </FactsRail>,
    );
    expect(screen.getByRole("complementary", { name: "Facts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Criteria/ })).toHaveTextContent("CriteriaPassing 2 of 4");
    expect(screen.getByText("Owner").nextSibling).toHaveTextContent("Bao");
  });

  it("legends only the segments present", () => {
    render(
      <CoverageBar
        segments={[
          { key: "pass", label: "Passing", count: 2, tone: "ready" },
          { key: "fail", label: "Failing", count: 0, tone: "err" },
          { key: "none", label: "Not judged", count: 1 },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Passing 2", "Not judged 1"]);
  });

  it("draws nothing when there is nothing to cover", () => {
    render(<CoverageBar segments={[{ key: "pass", label: "Passing", count: 0 }]} />);
    expect(screen.queryByTestId("coverage-bar")).toBeNull();
  });
});
