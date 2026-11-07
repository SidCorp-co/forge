// The collapsed rail is icons only, everywhere in it (ISS-1073 round 3, rail-collapsed-d on dev.571):
// round 2 made its nav rows icons, but its top and foot still drew "SidCorp", "Search", "PROJECT",
// "SPACE", "What's new" on two lines, "Help" and a version cut to "v0.4....". Collapsed, the org is its
// avatar, the tiers are named only to a screen reader, each button is its icon named on hover, and
// the version is the Docs button's hover. Expanded, every word stays.
// @direct-test-of packages/web-v2/src/design/patterns/nav-rail.tsx
// @direct-test-of packages/web-v2/src/design/patterns/rail-button.tsx
// @direct-test-of packages/web-v2/src/features/shell/components/sidebar-version.tsx

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavRail, type NavEntry, RailButton } from "@/design";
import { OrgSwitcher } from "@/features/orgs";
import { ProjectSwitcher } from "@/features/shell/components/project-switcher";
import { SidebarSearch } from "@/features/shell/components/sidebar-search";
import { SidebarVersion } from "@/features/shell/components/sidebar-version";
import { Seeded } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("@/features/orgs/active-org", async (orig) => ({
  ...(await orig<typeof import("@/features/orgs/active-org")>()),
  useActiveOrg: () => ({ orgs: [{ id: "o1", name: "SidCorp", isPersonal: false }], activeOrg: { id: "o1", name: "SidCorp", isPersonal: false }, activeOrgId: "o1", setActiveOrg: () => {}, isSingle: true, resolved: true }),
}));

afterEach(cleanup);

const ITEMS: NavEntry[] = [{ key: "overview", label: "Overview", icon: "grid" }];

/** What the rail draws as text a person reads: every text node not hidden, counts aside. */
function words(root: HTMLElement): string[] {
  const out: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent?.trim() ?? "";
    const el = n.parentElement;
    if (!text || !el || el.closest("[aria-hidden=true], .sr-only")) continue;
    out.push(text);
  }
  return out;
}

function rail(compact: boolean) {
  return render(
    <Seeded data={[[["forge", "version"], { version: "0.4.0-dev.571", sourceCommit: null }]]}>
      <NavRail
        compact={compact}
        workspaceItems={ITEMS}
        projectItems={ITEMS.map((i) => ({ ...i, key: "proj" }))}
        projectSwitcher={
          <ProjectSwitcher
            compact={compact}
            project={{ name: "Hop", initials: "HO", tint: "#eef", ink: "#336", liveRuns: 3 }}
            projects={[]}
            activeSlug="hop"
            onSelect={() => {}}
            onSettings={() => {}}
            onTogglePin={() => {}}
            onAllProjects={() => {}}
            onNewProject={() => {}}
          />
        }
        activeKey="overview"
        orgSwitcher={<OrgSwitcher variant={compact ? "compact" : "brand"} />}
        search={<SidebarSearch onOpen={() => {}} compact={compact} icon={!compact} />}
        version={
          <>
            <RailButton icon="star" label="What's new" compact={compact} onClick={() => {}} />
            <RailButton icon="help" label="Help" compact={compact} onClick={() => {}} />
            <SidebarVersion onDocs={() => {}} activeKey="overview" compact={compact} />
          </>
        }
        user={{ initials: "QA" }}
        onToggleCollapsed={() => {}}
      />
    </Seeded>,
  );
}

describe("the collapsed rail", () => {
  it("draws no word at its top or its foot: the org is its avatar, and no tier label, button name or version is text", () => {
    const { container } = rail(true);
    const nav = container.querySelector("nav") as HTMLElement;
    // the org's avatar letters and the reader's own initials are pictures, not words
    expect(words(nav).filter((w) => !["SI", "HO", "QA"].includes(w))).toEqual([]);
    expect(screen.getByTestId("org-avatar")).toHaveTextContent("SI");
  });

  it("names every control it draws to a reader and on hover, the version on the Docs button's", () => {
    rail(true);
    expect(screen.getByRole("button", { name: "Docs · Forge v0.4.0-dev.571" })).toBeTruthy();
    // the project's live runs: a dot on its mark, counted in its name
    expect(screen.getByRole("button", { name: /Hop.*3 live/ })).toBeTruthy();
    for (const name of ["What's new", "Help", "Search"]) {
      const b = screen.getByRole("button", { name: new RegExp(name, "i") });
      expect(b.getAttribute("title") ?? "", name).toMatch(new RegExp(name, "i"));
    }
    expect(screen.getByRole("group", { name: /project/i })).toBeTruthy();
    expect(screen.getByRole("group", { name: /workspace/i })).toBeTruthy();
  });

  it("keeps every word where the rail is expanded", () => {
    const { container } = rail(false);
    const said = words(container.querySelector("nav") as HTMLElement).join(" ");
    for (const w of ["What's new", "Help", "Forge v0.4.0-dev.571", "3 live"]) expect(said).toContain(w);
  });
});
