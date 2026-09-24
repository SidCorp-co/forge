// @vitest-environment jsdom
//
// ISS-1217 — a promote project Forge cannot compare is listed with its reason and no age.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PulseResponse, PulseWork } from "../types";
import { ActionQueue } from "./action-queue";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

const NOW = Date.parse("2026-09-23T14:30:00.000Z");
const empty = { total: 0, shown: [] };

/** Only what the queue reads; the rest of the pulse is another section's. */
function pulse(work: Partial<PulseWork>): PulseResponse {
  return {
    liveness: { stuckRuns: empty },
    work: {
      abandoned: empty,
      releaseWaiting: empty,
      notOnLive: empty,
      liveUnmeasured: empty,
      silentProjects: empty,
      neverRanProjects: empty,
      ...work,
    },
  } as unknown as PulseResponse;
}

describe("the action queue (ISS-1217)", () => {
  it("lists an uncomparable project with its reason and shows no elapsed time for it", () => {
    render(
      <ActionQueue
        nowMs={NOW}
        pulse={pulse({
          liveUnmeasured: {
            total: 1,
            shown: [
              {
                id: "p1",
                slug: "sid-desk",
                name: "SidDesk",
                baseBranch: "staging",
                liveBranch: "master",
                reason: "the git host refused the deploy key attached to this project",
              },
            ],
          },
        })}
      />,
    );
    const row = screen.getByRole("button", {
      name: "Promote projects Forge could not fully compare: 1 — open the list",
    });
    expect(row).not.toHaveTextContent(/oldest/);
    fireEvent.click(row);
    const record = screen.getByRole("link", { name: /SidDesk/ });
    expect(record).toHaveAttribute("href", "/projects/sid-desk");
    expect(record).toHaveTextContent(
      "SidDeskthe git host refused the deploy key attached to this project",
    );
    expect(record).not.toHaveTextContent(/\d+[smhd]$/);
  });

  it("still shows the oldest age on a row whose records have one", () => {
    render(
      <ActionQueue
        nowMs={NOW}
        pulse={pulse({
          releaseWaiting: {
            total: 1,
            shown: [
              {
                documentId: "d1",
                issueRef: "ISS-1",
                title: "waiting",
                status: "awaiting_release",
                projectSlug: "sid-desk",
                ageSeconds: 7200,
              },
            ],
          },
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Waiting to be released: 1, oldest 2h — open the list" }),
    ).toHaveTextContent("oldest 2h");
  });
});
