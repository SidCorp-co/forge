// What the shell reads on every route (ISS-1070): the attention count once, whatever the active org
// resolves to, never the project's whole release list outside Releases, and one Needs you read for
// the rail's badges, the decisions read being the Dashboard's own. Each route is mounted
// under the workspace layout over a fake core that answers the org and the stored preference, so the
// active org resolves the way it does in the browser: after the first paint, not before it.
// @direct-test-of packages/web-v2/src/routes/_workspace/route.tsx
// @direct-test-of packages/web-v2/src/features/attention/hooks.ts
// @direct-test-of packages/web-v2/src/features/orgs/active-org.tsx
// @direct-test-of packages/web-v2/src/features/shell/nav-model.ts

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/providers/query-provider";
import { componentOf, renderRoute } from "@/test/route-tree";
import { type Sent, slowCore } from "@/test/waterfall";

vi.mock("@/lib/utils/use-location-search", () => ({ useLocationSearch: () => "" }));

import { Route as WorkspaceRoute } from "./_workspace/route";
import { Route as HomeRoute } from "./_workspace/index";
import { Route as DashboardRoute } from "./_workspace/projects/$slug/index";
import { Route as IssueRoute } from "./_workspace/projects/$slug/issues/$id/index";
import { Route as IssuesRoute } from "./_workspace/projects/$slug/issues/index";
import { Route as ActivityRoute } from "./_workspace/activity/index";

const WorkspaceLayout = componentOf(WorkspaceRoute, "routes/_workspace/route.tsx");

const ORG = "6a0f3c1e-2b4d-4e8f-9a7c-1d2e3f4a5b6c";
const PROJECT = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const ISSUE = "8b1d4e2f-2c7a-4b9e-a1f0-5d6e7c8b9a01";
const project = { id: PROJECT, slug: "forge", name: "Forge", role: "admin", orgId: ORG, orgRole: "owner" };
const issue = { id: ISSUE, projectId: PROJECT, displayId: "ISS-7", issSeq: 7, title: "a", status: "open", priority: "medium", labels: [], comments: [] };

function reply(method: string, path: string): unknown {
  if (method !== "GET") return {};
  if (path === "/orgs") return [{ id: ORG, slug: "acme", name: "Acme", isPersonal: true, role: "owner", createdAt: "2026-01-01T00:00:00.000Z" }];
  if (path === "/auth/me/preferences") return { theme: "system", language: null, notifyOnMention: true, activeOrgId: ORG, updatedAt: null };
  if (path.startsWith("/me/attention")) return { total: 0, waitingOnYou: 0, needsYou: [], runners: [], buckets: {} };
  if (path === "/projects") return [project];
  if (/^\/issues\/(ISS-7|[0-9a-f-]{36})\?/.test(path)) return issue;
  if (path.includes("/comments")) return { items: [], total: 0, nextCursor: null };
  if (path.includes("/activity")) return { items: [], nextCursor: null };
  if (path.includes("/attachments")) return [];
  if (path.includes("/dependencies")) return { incoming: [], outgoing: [] };
  if (path.includes("/criteria")) return { criteria: [] };
  if (path.includes("/park")) return { park: null };
  if (path.startsWith("/questions")) return { questions: [] };
  if (path.endsWith("/members") || path.endsWith("/labels")) return [];
  if (/\/releases(\?|$)/.test(path)) return { releases: [], counts: {} };
  if (path.endsWith("/needs-you")) return { generatedAt: "", areas: {}, items: [], requirementsInDelivery: 0, untriagedFeedback: 0, decisions: 0 };
  if (path.endsWith("/needs-you/decisions")) return { generatedAt: "", decisions: [], total: 0, notDecisions: [] };
  return undefined;
}

async function load(route: { options: { component?: unknown } }, at: string, pattern: string): Promise<Sent[]> {
  const sent = slowCore(reply, 30);
  await renderRoute({ at, pattern, page: componentOf(route, pattern), layout: WorkspaceLayout }, createQueryClient());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
  return sent.filter((s) => s.method === "GET");
}

const attentionReads = (sent: Sent[]) => sent.filter((s) => s.path.startsWith("/me/attention")).map((s) => s.path);
/** The project's whole release list: the Releases page's read, never the shell's or another page's. */
const wholeReleaseList = (sent: Sent[]) => sent.filter((s) => /^\/projects\/[^/]+\/releases$/.test(s.path)).map((s) => s.path);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROUTES = [
  ["Home", HomeRoute, "/", "/"],
  ["the project Dashboard", DashboardRoute, "/projects/forge", "/projects/$slug"],
  ["an issue", IssueRoute, "/projects/forge/issues/ISS-7", "/projects/$slug/issues/$id"],
  ["Issues", IssuesRoute, "/projects/forge/issues", "/projects/$slug/issues"],
  ["Activity", ActivityRoute, "/activity", "/activity"],
] as const;

describe("the shell's reads on each route", () => {
  it.each(ROUTES)("%s asks for the attention count once, scoped to the org it resolved", async (_name, route, at, pattern) => {
    const sent = await load(route, at, pattern);
    expect(attentionReads(sent)).toEqual([`/me/attention?orgId=${ORG}`]);
  });

  it.each(ROUTES)("%s never reads the project's whole release list", async (_name, route, at, pattern) => {
    const sent = await load(route, at, pattern);
    expect(wholeReleaseList(sent)).toEqual([]);
  });

  it.each(ROUTES)("%s reads Needs you once for the rail, and the decisions read only where the page lists them", async (name, route, at, pattern) => {
    const sent = await load(route, at, pattern);
    const paths = sent.map((s) => s.path);
    expect(paths.filter((p) => /\/needs-you$/.test(p))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith("/needs-you/decisions"))).toHaveLength(name === "the project Dashboard" ? 1 : 0);
  });
});
