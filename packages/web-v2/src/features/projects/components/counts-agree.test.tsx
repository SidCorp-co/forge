// @vitest-environment jsdom
//
// ISS-1229 r21: the projects page read "1 project need attention" and "1 projects". Each count
// agrees in number with what it counts, at one and at two.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceTotals } from "../types";
import { AttentionBanner } from "./attention-banner";
import { StatsBand } from "./stats-band";

afterEach(cleanup);

const totals = (n: number): WorkspaceTotals => ({
  projects: n,
  healthRead: "read",
  liveSessions: n,
  openIssues: n,
  runners: n,
  runnersTotal: n,
  spend24hUsd: 0,
});

const text = (node: HTMLElement) => node.textContent?.replace(/\s+/g, " ") ?? "";

describe("the projects page agrees in number", () => {
  it.each([
    [1, "1 project needs attention"],
    [2, "2 projects need attention"],
  ])("the attention banner at %i reads %j", (count, said) => {
    const { container } = render(
      <AttentionBanner count={count} read="read" attentionOnly={false} onToggle={() => {}} onRetry={() => {}} />,
    );
    expect(text(container)).toContain(said);
  });

  it.each([
    [1, ["1 project", "1/1 runner online"], ["1 projects", "runners online"]],
    [2, ["2 projects", "2/2 runners online"], ["runner online"]],
  ])("the workspace band at %i", (n, said, never) => {
    const { container } = render(<StatsBand totals={totals(n)} />);
    for (const words of said) expect(text(container)).toContain(words);
    for (const words of never) expect(text(container)).not.toContain(words);
  });
});

// ISS-1229 r25, judge-72: the band said "0 runners" where Overview said "0/1 runners online" for the
// same organization. The band counts runners as Overview does: online out of every runner.
describe("the workspace band counts runners as Overview does", () => {
  it.each([
    [0, 1, "0/1 runner online"],
    [1, 2, "1/2 runners online"],
    [0, 0, "0/0 runners online"],
  ])("%i online of %i reads %j", (online, total, said) => {
    const { container } = render(<StatsBand totals={{ ...totals(1), runners: online, runnersTotal: total }} />);
    expect(text(container)).toContain(said);
  });
});
