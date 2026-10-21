// REQ-48 BC-11: one number waits on the person. The Approvals page's count, its menu badge, the
// Dashboard's Needs you (three shown and "+n more") and /attention's part for the project (three shown
// and "+n more", and the rail's attention total) all read `total` from the one Needs you decisions
// read. The read here carries more decisions than it lists, as core's does past its page, so a
// surface that counts the rows it was handed instead of `total` reads a different number and fails.

import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionScreen, useAttention } from "@/features/attention";
import { ProjectHome } from "@/features/project-home";
import { projectMenu } from "@/features/shell/nav-model";
import { APPROVALS_PROJECT as P, APPROVALS_READ } from "@/test/approvals-read";
import { STATUS } from "@/test/project-status";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ApprovalsScreen } from "@/features/approvals";

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
    if (path.startsWith(`/projects/${P}/status`)) return { body: STATUS };
    if (path.startsWith("/conversations?")) return { body: { items: [], total: 0 } };
    if (path === "/me/attention") {
      const part = { projectSlug: "hop", projectName: "Hop", total: READ.total, decisions: READ.decisions.slice(0, NEEDS_YOU_PERSON_CAP) };
      return { body: { needsYou: [part], mentions: [], failedJobs: [], channelGates: [], statusReports: [] } };
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
  it("is the same on the Approvals page, its menu badge, the Dashboard and /attention", async () => {
    core();
    const page = renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    const pageCount = Number((await screen.findByTestId("approvals-count")).dataset.total);
    page.unmount();

    const badge = projectMenu({ decisions: READ }).find((e) => "key" in e && e.key === "proj-approvals");
    const badgeCount = badge && "badge" in badge ? badge.badge : undefined;

    const home = renderWithQuery(<ProjectHome projectId={P} slug="hop" />);
    const homeCount = await cappedCount(await screen.findByTestId("needs-you-decisions"));
    expect(within(home.container).getByTestId("needs-you-more")).toHaveAttribute("href", "/projects/hop/approvals");
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

    expect({ pageCount, badgeCount, homeCount, attentionCount, railCount }).toEqual({
      pageCount: READ.total,
      badgeCount: READ.total,
      homeCount: READ.total,
      attentionCount: READ.total,
      railCount: READ.total,
    });
  });
});
