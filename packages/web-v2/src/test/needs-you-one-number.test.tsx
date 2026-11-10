// REQ-48 BC-11: one number waits on the person. The Approvals page's count (it has no rail row since
// ISS-1071, so no menu badge), the project home's Needs you (its group counts the home read's total,
// which core takes from the same decisions read, REQ-43 BC-17) and /attention's part for the project (three shown
// and "+n more", and the rail's attention total) all read `total` from the one Needs you decisions
// read. The read here carries more decisions than it lists, as core's does past its page, so a
// surface that counts the rows it was handed instead of `total` reads a different number and fails.

import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionScreen, useAttention } from "@/features/attention";
import { APPROVALS_PROJECT as P, APPROVALS_READ } from "@/test/approvals-read";
import { emptyHome } from "@/test/project-home";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ApprovalsScreen } from "@/features/approvals";
import { ProjectHome } from "@/features/project-home";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/runners", () => ({ useDevices: () => ({ data: [] }) }));
vi.mock("@/features/projects/hooks", () => ({ useOrgScopedProjects: () => ({ projects: [{ id: P, slug: "hop", name: "Hop" }], projectSlugs: new Set(["hop"]) }) }));
vi.mock("@/features/conversations/components/conversation-chat", () => ({ ConversationChat: () => null }));

afterEach(() => vi.unstubAllGlobals());

/** Past its page: two more decisions wait than the read lists. */
const READ = { ...APPROVALS_READ, total: APPROVALS_READ.total + 2 };

function core() {
  return fakeCore(({ path }) => {
    if (path === `/projects/${P}/needs-you/decisions`) return { body: READ };
    if (path.startsWith(`/projects/${P}/home?`)) return { body: emptyHome(P, { decisions: READ.decisions.slice(0, NEEDS_YOU_PERSON_CAP), total: READ.total }) };
    if (path.startsWith("/conversations?")) return { body: { items: [], total: 0 } };
    if (path === "/me/attention") {
      const part = { projectSlug: "hop", projectName: "Hop", total: READ.total, decisions: READ.decisions.slice(0, NEEDS_YOU_PERSON_CAP), owed: [] };
      const none = { decisions: READ.total, owed: 0, mentions: 0, failedJobs: 0, channelGates: 0, statusReports: 0, offlineRunners: 0 };
      return { body: { needsYou: [part], mentions: [], failedJobs: [], channelGates: [], statusReports: [], offlineRunners: [], counts: none, waitingOnYou: READ.total, needsYouNotSent: Math.max(0, READ.total - part.decisions.length), total: READ.total } };
    }
    return undefined;
  });
}

/** Rows a capped list draws plus the "+n more" it counts behind them. */
async function cappedCount(within: HTMLElement): Promise<number> {
  const shown = (await screen.findAllByTestId("needs-you-decision")).filter((r) => within.contains(r)).length;
  const more = [...within.querySelectorAll("[data-testid=needs-you-more]")].map((m) => Number(/\+(\d+)/.exec(m.textContent ?? "")?.[1] ?? 0));
  return shown + (more[0] ?? 0);
}

function AttentionTotal() {
  return <span data-testid="attention-total">{useAttention().total}</span>;
}

describe("one Needs you number", () => {
  it("is the same on the Approvals page, the Dashboard and /attention", async () => {
    core();
    const page = renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    const pageCount = Number((await screen.findByTestId("approvals-count")).dataset.total);
    page.unmount();

    const home = renderWithQuery(<ProjectHome projectId={P} slug="hop" />);
    const needs = (await screen.findAllByTestId("list-group")).find((g) => g.getAttribute("data-group") === "needs") as HTMLElement;
    const homeCount = Number(within(needs).getByTestId("group-count").textContent);
    home.unmount();

    const attention = renderWithQuery(
      <>
        <AttentionScreen />
        <AttentionTotal />
      </>,
    );
    const section = await screen.findByTestId("attention-needs-you");
    const attentionCount = await cappedCount(section);
    const railCount = Number((await screen.findByTestId("attention-total")).textContent);
    expect(within(section).getByTestId("needs-you-more")).toHaveAttribute("href", "/projects/hop/approvals");
    attention.unmount();

    expect({ pageCount, homeCount, attentionCount, railCount }).toEqual({
      pageCount: READ.total,
      homeCount: READ.total,
      attentionCount: READ.total,
      railCount: READ.total,
    });
  });
});
