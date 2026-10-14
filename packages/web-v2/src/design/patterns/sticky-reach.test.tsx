// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1166 / ISS-1169, rounds 2 and 3. A table's sticky first column is pinned over whatever scrolls under
// it, so it takes that much of the width away from every other column for good. Uncapped, the longest
// agent handle made it 234px of a 356px table at 390px, and "Give a credential" could not be scrolled
// out from under it. jsdom has no layout, so each table is drawn here in a real Chrome at the width
// the app has at 390px (a 17px gutter either side) and every control in its body is scrolled as close
// to view as the table allows; it fails when one still sits under the sticky column or past the edge.
//
// Round 3 adds what round 2 left unmeasured. A name in a sticky cell reads whole or is cut on one line
// with the whole of it in a title, and is never broken mid-word ("AdminHub UI" over four lines); and at
// 1280px, in the 894px the settings page leaves a table, every row action sits inside the table's frame
// with nothing to scroll sideways.

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentAccountRow } from "@/features/agent-accounts/types";
import type { PatToken } from "@/features/settings/types";
import type { ProjectConsoleItem } from "@/features/projects/types";
import type { PulseResponse } from "@/features/overview/types";
import { closeChrome, measureReach, type Reach, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const PHONE_COLUMN = 356;
const PHONE = 390;
// The settings page at 1280px: the width the table has beside the nav rail and the page's own gutters.
const DESKTOP_COLUMN = 894;
const DESKTOP = 1280;

// The longest handle the server takes is 40 characters (`create-agent-form.tsx:HANDLE_RULE`), and a
// display name is free text.
const LONGEST_HANDLE = "dodgeprint-api-production-worker-box-01".padEnd(40, "x");
// A value with no place to break it is the one the column cannot shrink around.
const UNBREAKABLE = "x".repeat(40);
const LONG_DISPLAY_NAME = "Dodgeprint API production worker, the box in the second rack";

const state = vi.hoisted(() => ({ agents: [] as AgentAccountRow[] }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { id: "o1", name: "Acme", role: "admin" } }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [{ id: "p1", name: "alpha" }], isLoading: false }),
  useOrgScopedProjects: () => ({ projects: [{ id: "p1", name: "alpha" }], isLoading: false }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/features/agent-accounts/hooks", () => ({
  useAgentAccounts: () => ({ data: state.agents, isLoading: false, isError: false }),
  useMintAgentCredential: () => ({ mutateAsync: async () => ({ plaintext: "" }), isPending: false }),
  useRevokeAgentCredentials: () => ({ mutateAsync: async () => ({ revoked: 0 }), isPending: false }),
  useSetAgentDisplayName: () => ({ mutateAsync: async () => undefined, isPending: false }),
  useCreateAgent: () => ({ mutateAsync: async () => undefined, isPending: false, isError: false }),
}));

import { AgentsTab } from "@/features/agent-accounts/components/agents-tab";
import { WorkSitting } from "@/features/overview/components/work-sitting";
import { ProjectList } from "@/features/projects/components/project-list";
import { TokenList } from "@/features/settings/components/token-list";

function agent(n: number, over: Partial<AgentAccountRow> = {}): AgentAccountRow {
  return {
    userId: `u${n}`,
    handle: `agent-${n}`,
    displayName: null,
    email: `a${n}@x`,
    projects: [{ id: "p1", role: "member" }],
    createdAt: "2026-09-01T00:00:00Z",
    activeTokens: 0,
    canAct: false,
    ...over,
  };
}

function token(name: string, over: Partial<PatToken> = {}): PatToken {
  return {
    id: name,
    name,
    prefix: "forge_pat_prd_0001",
    scopes: ["read", "write"],
    projectIds: null,
    permissions: null,
    grant: "legacy",
    boundProjectId: null,
    expiresAt: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    ...over,
  };
}

function project(name: string): ProjectConsoleItem {
  return {
    id: name, slug: name, name, orgId: "o1", orgName: "Org", orgIsPersonal: false, role: "admin",
    createdAt: "2026-10-01T00:00:00Z", description: "A project", repoPath: `repo/${name}`, healthRead: "read",
    health: "healthy", liveRuns: 1, openIssues: 3, runnerCount: 1, spend24hUsd: 1, memberCount: 2, members: ["AB", "CD"],
    lastActivityAt: "2026-10-02T00:00:00Z", pinned: false,
  } as ProjectConsoleItem;
}

const clearOf = (reach: Reach[]) => reach.filter((r) => !r.clear);
// The floor and the cap on a sticky column below the `sm` breakpoint: 8rem and 10rem.
const STICKY_FLOOR_PX = 128;
const STICKY_CAP_PX = 160;

async function measured(markup: string, table: string, column = PHONE_COLUMN, viewport = PHONE) {
  const { reach, overflowing, stickyWidest, pinned, broken, clipped, scrolling, pillLines, pills, headerLost, bodyRows } = await measureReach(markup, column, viewport);
  return {
    reach: reach.filter((r) => r.table === table),
    overflowing: overflowing.filter((o) => o.startsWith(`${table}:`)),
    stickyWidest: stickyWidest[table] ?? 0,
    pinned: pinned.filter((p) => p.table === table),
    broken: broken.filter((b) => b.startsWith(`${table}:`)),
    clipped: clipped.filter((c) => c.table === table),
    scrolling: scrolling.filter((s) => s.startsWith(`${table}:`)),
    pillLines,
    pills: pills.filter((p) => p.table === table),
    headerLost: headerLost.filter((h) => h === table),
    bodyRows: bodyRows[table] ?? 0,
  };
}

const unframed = (reach: Reach[]) => reach.filter((r) => !r.framed).map((r) => `${r.control} at ${r.left}-${r.right}`);
// What the two names the audit saw broken, and a name that cannot fit, are drawn as.
const WHOLE_NAMES = ["AdminHub UI", "SID_GROWTH"];

describe("a control in a table with a sticky first column scrolls clear of it at 390px", () => {
  it("Agents: every row action, with the longest handle and a long display name", async () => {
    state.agents = [
      ...Array.from({ length: 4 }, (_, i) => agent(i)),
      agent(4, { handle: LONGEST_HANDLE, activeTokens: 1, canAct: true }),
      agent(5, { displayName: LONG_DISPLAY_NAME, handle: LONGEST_HANDLE, activeTokens: 1, canAct: true }),
      agent(6, { handle: UNBREAKABLE, activeTokens: 1, canAct: true }),
    ];
    const { reach, overflowing, stickyWidest } = await measured(renderToStaticMarkup(<AgentsTab />), "Agents");
    expect(reach.filter((r) => r.control.startsWith("Give a credential")).length).toBe(7);
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
  });

  it("API Tokens: Revoke on a row whose name is as long as a name can be", async () => {
    const live = [token("iss974-walk-2"), token("a-token-named-by-someone-who-likes-long-names-0123456789"), token("T".repeat(60))];
    const markup = renderToStaticMarkup(<TokenList tokens={live} level={() => "User-level"} onRevoke={() => {}} revoking={false} />);
    const { reach, overflowing, stickyWidest } = await measured(markup, "Tokens that can reach your account");
    expect(reach.filter((r) => r.control.startsWith("Revoke")).length).toBe(3);
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
  });

  it("Projects list: each pin stays inside the sticky cell however long the name, and the rest still scrolls clear", async () => {
    const items = [project("alpha"), project("a-project-with-a-very-long-name-that-keeps-going-and-going"), project("p".repeat(60))];
    const markup = renderToStaticMarkup(
      <ProjectList items={items} now={Date.parse("2026-10-03T00:00:00Z")} onTogglePin={() => {}} sort={{ id: "recent", desc: true }} onSortChange={() => {}} />,
    );
    const { reach, overflowing, stickyWidest, pinned } = await measured(markup, "Projects");
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(pinned.filter((p) => p.control.includes("Pin project")).length).toBe(3);
    expect(pinned.filter((p) => !p.fits)).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
  });

  it("Overview, longest without a run: the links in the count columns", async () => {
    const row = (slug: string, name: string) => ({
      id: slug, slug, name, open: 4, in_flight: 2, awaiting_release: 1, blocked_on_person: 3,
      stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: "2026-09-20T00:00:00.000Z",
    });
    const pulse = {
      work: {
        buckets: { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 },
        blockedOnPersonAges: [],
        perProject: [row("alpha", "alpha"), row("long", "a-project-with-a-very-long-name-that-keeps-going-and-going"), row("solid", "p".repeat(60))],
      },
    } as unknown as PulseResponse;
    const markup = renderToStaticMarkup(<WorkSitting pulse={pulse} nowMs={Date.parse("2026-10-03T00:00:00Z")} />);
    const { reach, overflowing, stickyWidest, pinned } = await measured(markup, "Longest without an issue run");
    expect(reach.length).toBeGreaterThan(0);
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(pinned.length).toBe(3);
    expect(pinned.filter((p) => !p.fits)).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
  });
});

describe("a name in a sticky cell reads whole at 390px, or is cut on one line with the whole of it in a title", () => {
  it("Projects: a name is never broken mid-word, and one that fits is not cut", async () => {
    const items = [...WHOLE_NAMES, "a-project-with-a-very-long-name-that-keeps-going-and-going", "p".repeat(60)].map(project);
    const markup = renderToStaticMarkup(
      <ProjectList items={items} now={Date.parse("2026-10-03T00:00:00Z")} onTogglePin={() => {}} sort={{ id: "recent", desc: true }} onSortChange={() => {}} />,
    );
    const { broken, clipped, reach, pinned } = await measured(markup, "Projects");
    expect(broken).toEqual([]);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.filter((c) => !c.titled)).toEqual([]);
    expect(clipped.map((c) => c.text).filter((t) => WHOLE_NAMES.includes(t))).toEqual([]);
    expect(clearOf(reach)).toEqual([]);
    expect(pinned.filter((p) => !p.fits)).toEqual([]);
  });

  it("Agents: a handle and a display name are never broken mid-word", async () => {
    state.agents = [
      agent(1, { displayName: "AdminHub UI" }),
      agent(2, { handle: "SID_GROWTH" }),
      agent(3, { handle: LONGEST_HANDLE, activeTokens: 1, canAct: true }),
      agent(4, { displayName: LONG_DISPLAY_NAME, activeTokens: 1, canAct: true }),
      agent(5, { handle: UNBREAKABLE }),
    ];
    const { broken, clipped, reach } = await measured(renderToStaticMarkup(<AgentsTab />), "Agents");
    expect(broken).toEqual([]);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.filter((c) => !c.titled)).toEqual([]);
    expect(clipped.map((c) => c.text).filter((t) => WHOLE_NAMES.includes(t))).toEqual([]);
    expect(clearOf(reach)).toEqual([]);
  });

  it("API Tokens: a name and the line under it are never broken mid-word", async () => {
    const live = [token("AdminHub UI"), token("SID_GROWTH"), token("a-token-named-by-someone-who-likes-long-names-0123456789")];
    const markup = renderToStaticMarkup(<TokenList tokens={live} level={() => "User-level"} onRevoke={() => {}} revoking={false} />);
    const { broken, clipped, reach } = await measured(markup, "Tokens that can reach your account");
    expect(broken).toEqual([]);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.filter((c) => !c.titled)).toEqual([]);
    expect(clipped.map((c) => c.text).filter((t) => WHOLE_NAMES.includes(t))).toEqual([]);
    expect(clearOf(reach)).toEqual([]);
  });

  it("Overview: a project name in the silence table is never broken mid-word", async () => {
    const row = (name: string) => ({
      id: name, slug: name, name, open: 4, in_flight: 2, awaiting_release: 1, blocked_on_person: 3,
      stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: "2026-09-20T00:00:00.000Z",
    });
    const pulse = {
      work: {
        buckets: { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 },
        blockedOnPersonAges: [],
        perProject: [...WHOLE_NAMES, "a-project-with-a-very-long-name-that-keeps-going-and-going", "p".repeat(60)].map(row),
      },
    } as unknown as PulseResponse;
    const markup = renderToStaticMarkup(<WorkSitting pulse={pulse} nowMs={Date.parse("2026-10-03T00:00:00Z")} />);
    const { broken, clipped } = await measured(markup, "Longest without an issue run");
    expect(broken).toEqual([]);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.filter((c) => !c.titled)).toEqual([]);
    expect(clipped.map((c) => c.text).filter((t) => WHOLE_NAMES.includes(t))).toEqual([]);
  });
});

describe("every row action sits inside the table's frame at 1280px, with nothing to scroll sideways", () => {
  it("Agents: the handles beta holds, the longest the server takes, and a long display name, each with all three actions", async () => {
    // Beta's own handles, read off https://forge-beta.sidcorp.co/settings?tab=agents at 1280px: the table was 940px in
    // 894px of frame with these, though it fitted with the short ones a first fixture used.
    state.agents = [
      ...["sid-accountants", "epodsystem-core", "home-kieutrung-services-anhome", "butlocs", "erp", "sid-desk"].map((handle, i) =>
        agent(i, { handle, projects: [], activeTokens: 1, canAct: false }),
      ),
      agent(6, { handle: LONGEST_HANDLE, activeTokens: 1, canAct: true }),
      agent(7, { displayName: LONG_DISPLAY_NAME, handle: "home-kieutrung-services-anhome", activeTokens: 1, canAct: true }),
      agent(8, { handle: UNBREAKABLE }),
      ...Array.from({ length: 5 }, (_, i) => agent(9 + i, { activeTokens: i % 2, canAct: i % 2 === 1 })),
    ];
    const { reach, scrolling } = await measured(renderToStaticMarkup(<AgentsTab />), "Agents", DESKTOP_COLUMN, DESKTOP);
    expect(reach.filter((r) => r.control.startsWith("Edit self")).length).toBe(state.agents.length);
    expect(unframed(reach)).toEqual([]);
    expect(scrolling).toEqual([]);
  });

  it("API Tokens: Revoke on a row that reaches through several named permissions", async () => {
    const named = ["issues:read", "issues:write", "schedules:read", "schedules:write", "knowledge:read"];
    const live = [
      token("iss974-walk-2"),
      token("ci", { grant: "named", permissions: named, boundProjectId: "p1", expiresAt: "2027-01-01T00:00:00.000Z", lastUsedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const markup = renderToStaticMarkup(<TokenList tokens={live} level={(t) => (t.boundProjectId ? "Project: forge-dev" : "User-level")} onRevoke={() => {}} revoking={false} />);
    const { reach, scrolling } = await measured(markup, "Tokens that can reach your account", DESKTOP_COLUMN, DESKTOP);
    expect(reach.filter((r) => r.control.startsWith("Revoke")).length).toBe(2);
    expect(unframed(reach)).toEqual([]);
    expect(scrolling).toEqual([]);
  });
});

// ISS-1264: above 100 rows a table draws only the rows in view and scrolls down inside a frame of its
// own. The measurements above are about a table's width; these say they still hold for one that is
// windowed, and that the header is still at the top of the frame when the rows scroll under it.
describe("a table of more than 100 rows, windowed", () => {
  const MANY = 300;
  const long = () => {
    state.agents = Array.from({ length: MANY }, (_, i) => agent(i, { handle: i === 7 ? LONGEST_HANDLE : `agent-${i}`, activeTokens: i % 2, canAct: i % 2 === 1 }));
  };

  it("Agents at 390px: draws a window of the rows, keeps its sticky column, and every action scrolls clear of it", async () => {
    long();
    const { reach, overflowing, stickyWidest, headerLost, bodyRows } = await measured(renderToStaticMarkup(<AgentsTab />), "Agents");
    expect(bodyRows).toBeGreaterThan(5);
    expect(bodyRows).toBeLessThan(60);
    expect(reach.length).toBeGreaterThan(0);
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
    expect(headerLost).toEqual([]);
  });

  it("Agents at 1280px: every action inside the frame and nothing to scroll sideways", async () => {
    long();
    const { reach, scrolling, bodyRows, headerLost } = await measured(renderToStaticMarkup(<AgentsTab />), "Agents", DESKTOP_COLUMN, DESKTOP);
    expect(bodyRows).toBeLessThan(60);
    expect(reach.length).toBeGreaterThan(0);
    expect(unframed(reach)).toEqual([]);
    expect(scrolling).toEqual([]);
    expect(headerLost).toEqual([]);
  });
});

describe("the level pill of a token bound to a project", () => {
  const PROJECT = "qa-project-available-for-testing-0".padEnd(40, "x");
  const bound = () => [token("ci", { boundProjectId: "p1" })];
  const draw = () =>
    renderToStaticMarkup(
      <TokenList tokens={bound()} level={() => `Project: ${PROJECT}`} onRevoke={() => {}} revoking={false} />,
    );

  it("is a project name 40 characters long", () => {
    expect(PROJECT).toHaveLength(40);
  });

  it("reads on one line at 390px, never broken at a hyphen", async () => {
    const { pillLines } = await measured(draw(), "Tokens that can reach your account");
    expect(pillLines[`Project: ${PROJECT}`]).toBe(1);
  });

  it("sits inside the table's frame at 390px before anything is scrolled sideways, with the whole name in its title", async () => {
    const { pills } = await measured(draw(), "Tokens that can reach your account");
    const pill = pills.find((p) => p.text.includes(PROJECT.slice(0, 20)));
    expect(pill, `no pill for the project in ${JSON.stringify(pills)}`).toBeDefined();
    expect(pill?.framed, "the pill runs past the table's frame, so its end is found only by scrolling sideways").toBe(true);
    expect(pill?.titled).toBe(true);
  });

  it("reads on one line at 1280px with the table inside its frame, and the whole name in its title", async () => {
    const { pillLines, pills, scrolling } = await measured(draw(), "Tokens that can reach your account", DESKTOP_COLUMN, DESKTOP);
    expect(pillLines[`Project: ${PROJECT}`]).toBe(1);
    expect(pills.find((p) => p.text === `Project: ${PROJECT}`)).toMatchObject({ framed: true, titled: true });
    expect(scrolling).toEqual([]);
  });
});
