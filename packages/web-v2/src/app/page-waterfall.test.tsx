// A project page holds the project's slug, and an issue page the issue's key, from the URL. Core
// takes both in place of the uuids, so a page's reads leave at once instead of waiting a round trip
// for the projects list (or the issue) to say which uuid to ask about, and switching to the uuid
// once it is known sends none of them twice. Drawn the way devtools draws a page load.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/providers/query-provider";
import { renderWithQuery } from "@/test/render";
import { depthOf, samePlace, type Sent, slowCore } from "@/test/waterfall";

const nav = vi.hoisted(() => ({ pathname: "/projects/forge", params: { slug: "forge" } as Record<string, string> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/utils/use-location-search", () => ({ useLocationSearch: () => "" }));

import WorkspaceLayout from "./(workspace)/layout";
import ProjectOverviewPage from "./(workspace)/projects/[slug]/page";
import ProjectIssueDetailPage from "./(workspace)/projects/[slug]/issues/[id]/page";
import ProjectRequirementsPage from "./(workspace)/projects/[slug]/requirements/page";

const PROJECT = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const ISSUE = "8b1d4e2f-2c7a-4b9e-a1f0-5d6e7c8b9a01";
const project = { id: PROJECT, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null };
const issue = { id: ISSUE, projectId: PROJECT, displayId: "ISS-7", issSeq: 7, title: "a", status: "open", priority: "medium", labels: [], comments: [] };

function reply(method: string, path: string): unknown {
  if (method !== "GET") return {};
  if (path === "/projects") return [project];
  if (/^\/issues\/(ISS-7|[0-9a-f-]{36})\?/.test(path)) return issue;
  if (path.endsWith("/comments") || path.includes("/comments?")) return [];
  if (path.includes("/activity")) return { items: [], nextCursor: null };
  if (path.includes("/attachments")) return [];
  if (path.includes("/dependencies")) return { incoming: [], outgoing: [] };
  if (path.includes("/criteria")) return { criteria: [] };
  if (path.includes("/patterns")) return { catalog: { declared: true, detail: null }, patterns: [], dispatchable: true, refusal: null, returned: null, decidable: [] };
  if (path.includes("/park")) return { park: null };
  if (path.startsWith("/questions")) return { questions: [] };
  if (path.endsWith("/requirements")) return { requirements: [] };
  if (path.endsWith("/releases")) return { releases: [], counts: {} };
  if (path.endsWith("/feedback")) return { feedback: [] };
  if (path.endsWith("/content-language")) return { contentLanguage: null };
  if (path.endsWith("/members") || path.endsWith("/labels")) return [];
  if (path.endsWith("/workflows")) return { workflows: [] };
  if (path.endsWith("/workflow-templates")) return { templates: [] };
  if (path.includes("/mockups?")) return { mockups: [], returned: 0 };
  if (path.includes("/suggestions?")) return { suggestions: [] };
  if (path.endsWith("/needs-you")) return { generatedAt: "", areas: {}, items: [], requirementsInDelivery: 0, untriagedFeedback: 0 };
  return undefined;
}

/** Every project- or issue-scoped read, which is what waits on the projects list today. A read the
 *  fake core does not serve fails and is fairly read again; one it answered must never be sent twice. */
const scoped = (s: Sent) => s.method === "GET" && /^\/(projects\/[^/?]+\/|issues\/|questions\?)/.test(s.path);

async function load(page: React.ReactElement, pathname: string, params: Record<string, string>) {
  nav.pathname = pathname;
  nav.params = params;
  const sent = slowCore(reply);
  renderWithQuery(<WorkspaceLayout>{page}</WorkspaceLayout>, createQueryClient());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });
  const list = sent.find((s) => s.path === "/projects");
  const reads = sent.filter(scoped);
  const place = (s: Sent) => samePlace(s.path, { [PROJECT]: "forge", [ISSUE]: "ISS-7" });
  const answered = reads.filter((s) => s.status === 200).map(place);
  const twice = reads.map(place).filter((p, i, all) => answered.includes(p) && all.indexOf(p) !== i);
  const firstSends = reads.filter((s, i) => reads.findIndex((r) => place(r) === place(s)) === i);
  const waterfall = {
    requests: sent.length,
    scopedReads: reads.length,
    serialDepth: Math.max(0, ...firstSends.map((s) => depthOf(sent, s))),
    sentBeforeTheList: reads.filter((s) => list?.end != null && s.start < list.end).length,
    sentTwice: twice,
  };
  console.log(`[waterfall] ${pathname} ${JSON.stringify(waterfall)}`);
  for (const s of reads) console.log(`[waterfall]   d${depthOf(sent, s)} ${Math.round(s.start)}-${Math.round(s.end ?? -1)} ${s.status} ${s.path}`);
  return { sent, reads, waterfall };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a project page's first reads", () => {
  it("leave with the page on the project dashboard, and none goes twice", async () => {
    const { waterfall } = await load(<ProjectOverviewPage />, "/projects/forge", { slug: "forge" });
    expect(waterfall.sentBeforeTheList).toBeGreaterThanOrEqual(8);
    expect(waterfall.serialDepth).toBe(1);
    expect(waterfall.sentTwice).toEqual([]);
  });

  it("leave with the page on Requirements, and none goes twice", async () => {
    const { reads, waterfall } = await load(<ProjectRequirementsPage />, "/projects/forge/requirements", { slug: "forge" });
    expect(reads.map((s) => s.path)).toEqual(
      expect.arrayContaining(["/projects/forge/requirements", "/projects/forge/forecast/requirements"]),
    );
    expect(waterfall.serialDepth).toBe(1);
    expect(waterfall.sentTwice).toEqual([]);
  });

  it("leave with the page on an issue, the issue's own reads included, and none goes twice", async () => {
    const { reads, waterfall } = await load(<ProjectIssueDetailPage />, "/projects/forge/issues/ISS-7", { slug: "forge", id: "ISS-7" });
    const firstWave = reads.filter((s) => depthOf(reads, s) === 1).map((s) => s.path.split("?")[0]);
    expect(waterfall.sentBeforeTheList).toBeGreaterThanOrEqual(15);
    expect(firstWave).toEqual(
      expect.arrayContaining([
        "/issues/ISS-7",
        "/issues/ISS-7/comments",
        "/issues/ISS-7/activity",
        "/issues/ISS-7/attachments",
        "/issues/ISS-7/dependencies",
        "/issues/ISS-7/cost-summary",
        "/issues/ISS-7/park",
        "/issues/ISS-7/criteria",
        "/issues/ISS-7/patterns",
        "/projects/forge/issues/standing/ISS-7",
      ]),
    );
    expect(waterfall.serialDepth).toBe(1);
    expect(waterfall.sentTwice).toEqual([]);
  });
});
