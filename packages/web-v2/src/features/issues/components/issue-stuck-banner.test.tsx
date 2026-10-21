// The issue page's Stuck banner (REQ-48 BC-5): a stuck issue says why in core's own sentence and whom
// it waits on; an issue not stuck draws no banner. The steward's note under it is the standing
// feature's (`StewardNoteLines`), read for an issue like any other item.

import type { IssueStanding } from "@forge/contracts/issue-standing";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { IssueStuckBanner } from "./issue-standing-bits";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const standing = (stuck: boolean) =>
  ({
    attentionGroup: stuck ? "stuck" : "waiting",
    waitingOn: {
      kind: "master",
      who: "Master",
      act: "cut 0.4.0",
      rule: "Forge could not carry out the answer by rule (X): y",
      ref: null,
      dueAt: null,
      says: {
        who: { key: "standing.who.master" },
        act: { key: "standing.act.cut", vars: { v: "0.4.0", more: null } },
        rule: { key: "standing.rule.draftAnswerRefused", vars: { code: "X", detail: "y" } },
      },
    },
    times: {
      actClass: "master_take",
      since: "2026-10-14T00:00:00.000Z",
      dueAt: null,
      stuck: stuck
        ? {
            code: "nobody_serves",
            since: "2026-10-14T00:00:00.000Z",
            reason: "It waits on the master, and no master serves this project.",
            via: null,
            says: { reason: { key: "standing.stuck.noMaster" } },
          }
        : null,
      carriedBy: null,
      basis: "b1",
    },
  }) as unknown as IssueStanding;

describe("the issue page's Stuck banner (REQ-48 BC-5)", () => {
  it("says why a stuck issue is stuck in core's sentence, and whom it waits on", () => {
    renderWithQuery(<IssueStuckBanner standing={standing(true)} />);
    const banner = screen.getByTestId("issue-stuck-banner");
    expect(banner).toHaveTextContent("It waits on the master, and no master serves this project.");
    expect(banner).toHaveTextContent("Master · cut 0.4.0");
  });

  it("draws nothing for an issue that is not stuck", () => {
    renderWithQuery(<IssueStuckBanner standing={standing(false)} />);
    expect(screen.queryByTestId("issue-stuck-banner")).toBeNull();
  });
});
