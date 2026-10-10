import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { projectSlugOf } from "@/features/shell/project-slug";
import { fakeCore, renderWithQuery } from "@/test/render";
import NotFound from "./not-found";

// A URL under a project that names no page (a stale link such as the retired /skill-updates, ISS-220)
// reads its 404 in the language that project's pages read in, not in English by default.

const path = vi.hoisted(() => ({ current: "/projects/hop/skill-updates" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current, useRouter: () => ({ push: vi.fn() }) }));

function missing(at: string, choice: "en" | "vi" | null) {
  path.current = at;
  fakeCore((call) => {
    if (call.path === "/auth/me/preferences") return { body: { theme: "system", language: choice, notifyOnMention: true, activeOrgId: null, updatedAt: null } };
    if (call.path === "/projects") return { body: [{ id: "p1", slug: "hop", name: "HOP" }] };
    if (call.path === "/projects/p1/content-language") return { body: { contentLanguage: "vi" } };
    return undefined;
  });
  renderWithQuery(<NotFound />);
}

describe("the page a missing URL reads", () => {
  it("reads in a vi project's language under that project's URL", async () => {
    missing("/projects/hop/skill-updates", null);
    expect(await screen.findByText("Không tìm thấy trang")).toBeInTheDocument(); // i18n-allow: Vietnamese text under test
  });

  it("keeps the person's own choice over the project's", async () => {
    missing("/projects/hop/skill-updates", "en");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("names the project slug only under /projects/<slug>", () => {
    expect(projectSlugOf("/projects/hop/skill-updates")).toBe("hop");
    expect(projectSlugOf("/ecosystems/threads")).toBeNull();
    expect(projectSlugOf(null)).toBeNull();
  });
});
