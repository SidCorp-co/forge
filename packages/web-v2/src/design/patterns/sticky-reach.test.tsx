// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1166 / ISS-1169, round 2. A table's sticky first column is pinned over whatever scrolls under
// it, so it takes that much of the width away from every other column for good. Uncapped, the longest
// agent handle made it 234px of a 356px table at 390px, and "Give a credential" could not be scrolled
// out from under it. jsdom has no layout, so each table is drawn here in a real Chrome at the width
// the app has at 390px (a 17px gutter either side) and every control in its body is scrolled as close
// to view as the table allows; it fails when one still sits under the sticky column or past the edge.

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentAccountRow } from "@/features/agent-accounts/types";
import type { PatToken } from "@/features/settings/types";
import type { ProjectConsoleItem } from "@/features/projects/types";
import type { PulseResponse } from "@/features/overview/types";
import { measureReach, type Reach } from "@/test-support/chrome-layout";

const PHONE_COLUMN = 356;
const PHONE = 390;

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

async function measured(markup: string, table: string) {
  const { reach, overflowing, stickyWidest } = await measureReach(markup, PHONE_COLUMN, PHONE);
  return {
    reach: reach.filter((r) => r.table === table),
    overflowing: overflowing.filter((o) => o.startsWith(`${table}:`)),
    stickyWidest: stickyWidest[table] ?? 0,
  };
}

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

  it("Projects list: the pin on a long project name stays in its own cell and the table still scrolls to the end", async () => {
    const items = [project("alpha"), project("a-project-with-a-very-long-name-that-keeps-going-and-going"), project("p".repeat(60))];
    const markup = renderToStaticMarkup(
      <ProjectList items={items} now={Date.parse("2026-10-03T00:00:00Z")} onTogglePin={() => {}} sort={{ id: "recent", desc: true }} onSortChange={() => {}} />,
    );
    const { reach, overflowing, stickyWidest } = await measured(markup, "Projects");
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
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
    const { reach, overflowing, stickyWidest } = await measured(markup, "Longest without an issue run");
    expect(reach.length).toBeGreaterThan(0);
    expect(clearOf(reach)).toEqual([]);
    expect(overflowing).toEqual([]);
    expect(stickyWidest).toBeGreaterThanOrEqual(STICKY_FLOOR_PX);
    expect(stickyWidest).toBeLessThanOrEqual(STICKY_CAP_PX);
  });
});
